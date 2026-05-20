const std = @import("std");
const zero_native = @import("zero-native");

pub const DependabotBridge = struct {
    allocator: std.mem.Allocator,
    io: std.Io,

    pub fn init(allocator: std.mem.Allocator, io: std.Io) DependabotBridge {
        return .{ .allocator = allocator, .io = io };
    }

    const ScanArgs = struct {
        self: *DependabotBridge,
        path: []const u8,
        id: []const u8,
        responder: zero_native.bridge.AsyncResponder,
    };

    pub fn runScan(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
        const self: *DependabotBridge = @ptrCast(@alignCast(context));
        
        // Parse payload for source path
        const path_key = "\"path\":\"";
        const start_index = std.mem.indexOf(u8, invocation.request.payload, path_key) orelse return error.InvalidRequest;
        const path_start = start_index + path_key.len;
        const end_index = std.mem.indexOfScalarPos(u8, invocation.request.payload, path_start, '"') orelse return error.InvalidRequest;
        const project_path = invocation.request.payload[path_start..end_index];

        const project_path_copy = try self.allocator.dupe(u8, project_path);
        const request_id_copy = try self.allocator.dupe(u8, invocation.request.id);

        const args = try self.allocator.create(ScanArgs);
        args.* = .{ .self = self, .path = project_path_copy, .id = request_id_copy, .responder = responder };

        const thread = try std.Thread.spawn(.{}, runScanInternal, .{args});
        thread.detach();
    }

    fn runScanInternal(args: *ScanArgs) void {
        const self = args.self;
        const project_path = args.path;
        const request_id = args.id;
        const responder = args.responder;
        const allocator = self.allocator;
        
        defer allocator.free(project_path);
        defer allocator.free(request_id);
        defer allocator.destroy(args);

        self.emitLog(responder, "[Dependabot] Starting dependency scan...") catch {};

        // Run python wrapper script
        // We assume the script is at "scripts/dependabot_runner.py" relative to the CWD
        // But since CWD might vary, we can use absolute or relative path safely if we assume CWD is project root.
        // The project is at /home/frano/my_app, and runner.zig is usually executed from there.
        // Alternatively, use absolute path: "/home/frano/my_app/scripts/dependabot_runner.py"
        const script_path = "/home/frano/my_app/scripts/dependabot_runner.py";

        const result = std.process.run(allocator, self.io, .{
            .argv = &.{ script_path, project_path },
        }) catch |err| {
            std.debug.print("[Error] Failed to start Dependabot script: {s}\n", .{@errorName(err)});
            self.fail(responder, request_id, "Failed to run dependabot script", err) catch {};
            return;
        };
        defer allocator.free(result.stdout);
        defer allocator.free(result.stderr);

        if (result.term != .exited or result.term.exited != 0) {
            std.debug.print("[Error] Dependabot script failed.\nStdout: {s}\nStderr: {s}\n", .{result.stdout, result.stderr});
            // It might still output JSON error on stdout
            if (result.stdout.len > 0) {
                responder.success(request_id, result.stdout) catch {};
                return;
            } else {
                self.fail(responder, request_id, "Dependabot script failed", error.ChildProcessFailed) catch {};
                return;
            }
        }

        std.debug.print("[Success] Dependabot script completed.\n", .{});
        self.emitLog(responder, "[Dependabot] Done. Results delivered.") catch {};

        // Return the JSON output
        responder.success(request_id, result.stdout) catch |err| {
            std.debug.print("[Error] Failed to send success response: {s}\n", .{@errorName(err)});
            return;
        };
    }

    fn emitLog(self: *DependabotBridge, responder: zero_native.bridge.AsyncResponder, message: []const u8) !void {
        const runtime: *zero_native.Runtime = @ptrCast(@alignCast(responder.context));
        const payload = std.fmt.allocPrint(self.allocator, "{{\"message\":\"{s}\"}}", .{message}) catch return;
        defer self.allocator.free(payload);
        
        runtime.emitWindowEvent(responder.source.window_id, "dependabot-log", payload) catch |err| {
            std.debug.print("[Error] emitWindowEvent failed: {s}\n", .{@errorName(err)});
        };
    }

    fn fail(self: *DependabotBridge, responder: zero_native.bridge.AsyncResponder, id: []const u8, message: []const u8, err: anyerror) !void {
        _ = self;
        var buf: [512]u8 = undefined;
        const full_message = std.fmt.bufPrint(&buf, "{s}: {s}", .{ message, @errorName(err) }) catch "Internal Error";
        responder.fail(id, .handler_failed, full_message) catch {};
    }
};

pub fn registerHandlers(bridge_instance: *DependabotBridge, handlers: *std.ArrayList(zero_native.bridge.AsyncHandler), commands: *std.ArrayList(zero_native.bridge.CommandPolicy)) !void {
    try handlers.append(.{
        .name = "dependabot.runScan",
        .context = bridge_instance,
        .invoke_fn = DependabotBridge.runScan,
    });
    try commands.append(.{ .name = "dependabot.runScan", .origins = &.{"*"} });
}
