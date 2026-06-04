const std = @import("std");
const zero_native = @import("zero-native");

pub const ProjectDetectorBridge = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    tokei_path: []const u8 = "",

    pub fn init(allocator: std.mem.Allocator, io: std.Io) ProjectDetectorBridge {
        return .{ .allocator = allocator, .io = io };
    }

    const DetectArgs = struct {
        self: *ProjectDetectorBridge,
        path: []const u8,
        id: []const u8,
        responder: zero_native.bridge.AsyncResponder,
    };

    pub fn detectStack(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
        const self: *ProjectDetectorBridge = @ptrCast(@alignCast(context));
        
        // Parse payload for source path
        const path_key = "\"path\":\"";
        const start_index = std.mem.indexOf(u8, invocation.request.payload, path_key) orelse return error.InvalidRequest;
        const path_start = start_index + path_key.len;
        const end_index = std.mem.indexOfScalarPos(u8, invocation.request.payload, path_start, '"') orelse return error.InvalidRequest;
        const project_path = invocation.request.payload[path_start..end_index];

        const project_path_copy = try self.allocator.dupe(u8, project_path);
        const request_id_copy = try self.allocator.dupe(u8, invocation.request.id);

        const args = try self.allocator.create(DetectArgs);
        args.* = .{ .self = self, .path = project_path_copy, .id = request_id_copy, .responder = responder };

        const thread = try std.Thread.spawn(.{}, detectStackInternal, .{args});
        thread.detach();
    }

    fn detectStackInternal(args: *DetectArgs) void {
        const self = args.self;
        const project_path = args.path;
        const request_id = args.id;
        const responder = args.responder;
        const allocator = self.allocator;
        
        defer allocator.free(project_path);
        defer allocator.free(request_id);
        defer allocator.destroy(args);

        // Resolve script path dynamically
        var exe_path_buf: [std.fs.max_path_bytes]u8 = undefined;
        const exe_path_len = std.Io.Dir.readLinkAbsolute(self.io, "/proc/self/exe", &exe_path_buf) catch {
            self.fail(responder, request_id, "Failed to resolve exe path", error.Unexpected) catch {};
            return;
        };
        const exe_dir_path = std.fs.path.dirname(exe_path_buf[0..exe_path_len]) orelse ".";

        const candidates = &[_][]const u8{
            "../../scripts/project_detector.py",
            "../../../scripts/project_detector.py",
            "../../../../scripts/project_detector.py",
            "../scripts/project_detector.py",
        };

        var resolved_script_path: ?[]const u8 = null;
        for (candidates) |candidate| {
            const joined_path = std.fs.path.join(allocator, &.{ exe_dir_path, candidate }) catch {
                self.fail(responder, request_id, "OOM building script path", error.OutOfMemory) catch {};
                return;
            };
            
            if (std.Io.Dir.openFileAbsolute(self.io, joined_path, .{})) |file| {
                file.close(self.io);
                resolved_script_path = joined_path;
                break;
            } else |_| {
                allocator.free(joined_path);
            }
        }

        const script_path = resolved_script_path orelse {
            self.fail(responder, request_id, "Failed to locate project_detector.py script", error.FileNotFound) catch {};
            return;
        };
        defer allocator.free(script_path);

        // Build argv: if tokei_path is configured, pass it as --tokei-path argument
        const result = std.process.run(allocator, self.io, .{
            .argv = if (self.tokei_path.len > 0)
                &.{ script_path, project_path, "--tokei-path", self.tokei_path }
            else
                &.{ script_path, project_path },
        }) catch |err| {
            std.debug.print("[Error] Failed to start project detector script: {s}\n", .{@errorName(err)});
            self.fail(responder, request_id, "Failed to run detector script", err) catch {};
            return;
        };
        defer allocator.free(result.stdout);
        defer allocator.free(result.stderr);

        // Always print stderr from the script (debug logs)
        if (result.stderr.len > 0) {
            std.debug.print("--- project_detector.py debug output ---\n{s}\n--- end debug output ---\n", .{result.stderr});
        }

        if (result.term != .exited or result.term.exited != 0) {
            std.debug.print("[Error] Project detector script failed (exit code).\nStdout: {s}\n", .{result.stdout});
            if (result.stdout.len > 0) {
                responder.success(request_id, result.stdout) catch {};
                return;
            } else {
                self.fail(responder, request_id, "Project detector script failed", error.ChildProcessFailed) catch {};
                return;
            }
        }

        std.debug.print("[Success] Project detector script completed. Output length: {d} bytes\n", .{result.stdout.len});

        responder.success(request_id, result.stdout) catch |err| {
            std.debug.print("[Error] Failed to send success response: {s}\n", .{@errorName(err)});
            return;
        };
    }

    fn fail(self: *ProjectDetectorBridge, responder: zero_native.bridge.AsyncResponder, id: []const u8, message: []const u8, err: anyerror) !void {
        _ = self;
        var buf: [512]u8 = undefined;
        const full_message = std.fmt.bufPrint(&buf, "{s}: {s}", .{ message, @errorName(err) }) catch "Internal Error";
        responder.fail(id, .handler_failed, full_message) catch {};
    }
};

pub fn registerHandlers(bridge_instance: *ProjectDetectorBridge, handlers: *std.ArrayList(zero_native.bridge.AsyncHandler), commands: *std.ArrayList(zero_native.bridge.CommandPolicy)) !void {
    try handlers.append(.{
        .name = "project.detectStack",
        .context = bridge_instance,
        .invoke_fn = ProjectDetectorBridge.detectStack,
    });
    try commands.append(.{ .name = "project.detectStack", .origins = &.{"*"} });
}
