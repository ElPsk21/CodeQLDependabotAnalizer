const std = @import("std");
const zero_native = @import("zero-native");

pub const CodeQlBridge = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    codeql_path: []const u8 = "/home/frano/Programs/opt/codeql/codeql",

    pub fn init(allocator: std.mem.Allocator, io: std.Io) CodeQlBridge {
        return .{ .allocator = allocator, .io = io };
    }

    const ScanArgs = struct {
        self: *CodeQlBridge,
        path: []const u8,
        id: []const u8,
        responder: zero_native.bridge.AsyncResponder,
    };

    pub fn runScan(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
        const self: *CodeQlBridge = @ptrCast(@alignCast(context));
        
        // Parse payload for source path
        // Simple manual parse to avoid std.json issues if they persist
        const path_key = "\"path\":\"";
        const start_index = std.mem.indexOf(u8, invocation.request.payload, path_key) orelse return error.InvalidRequest;
        const path_start = start_index + path_key.len;
        const end_index = std.mem.indexOfScalarPos(u8, invocation.request.payload, path_start, '"') orelse return error.InvalidRequest;
        const project_path = invocation.request.payload[path_start..end_index];

        // Duplicate path for the thread
        const project_path_copy = try self.allocator.dupe(u8, project_path);
        const request_id_copy = try self.allocator.dupe(u8, invocation.request.id);

        // Run in a separate thread to not block the bridge
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

        const db_full_path = std.fs.path.join(allocator, &.{ project_path, "codeql_db" }) catch return;
        defer allocator.free(db_full_path);
        
        const sarif_path = std.fs.path.join(allocator, &.{ project_path, "results.sarif" }) catch return;
        defer allocator.free(sarif_path);

        // 1. Database Create
        {
            self.emitLog(responder, "[CodeQL] Creating database...") catch {};
            const result = std.process.run(allocator, self.io, .{
                .argv = &.{ self.codeql_path, "database", "create", db_full_path, "--source-root", project_path, "--language=javascript", "--overwrite" },
            }) catch |err| {
                self.fail(responder, request_id, "Failed to run database create", err) catch {};
                return;
            };
            defer allocator.free(result.stdout);
            defer allocator.free(result.stderr);

            if (result.term != .exited or result.term.exited != 0) {
                self.fail(responder, request_id, "CodeQL database create failed", error.ChildProcessFailed) catch {};
                return;
            }
        }

        // 2. Database Analyze
        {
            self.emitLog(responder, "[CodeQL] Analyzing database...") catch {};
            const result = std.process.run(allocator, self.io, .{
                .argv = &.{ self.codeql_path, "database", "analyze", db_full_path, "--format=sarif-latest", "--output", sarif_path },
            }) catch |err| {
                self.fail(responder, request_id, "Failed to run database analyze", err) catch {};
                return;
            };
            defer allocator.free(result.stdout);
            defer allocator.free(result.stderr);

            if (result.term != .exited or result.term.exited != 0) {
                self.fail(responder, request_id, "CodeQL analysis failed", error.ChildProcessFailed) catch {};
                return;
            }
        }

        // 3. Read results
        const sarif_file = std.Io.Dir.openFileAbsolute(self.io, sarif_path, .{}) catch |err| {
            self.fail(responder, request_id, "Failed to open results", err) catch {};
            return;
        };
        defer sarif_file.close(self.io);

        const sarif_stat = sarif_file.stat(self.io) catch |err| {
            self.fail(responder, request_id, "Failed to stat results", err) catch {};
            return;
        };

        const sarif_content = allocator.alloc(u8, sarif_stat.size) catch |err| {
            self.fail(responder, request_id, "OOM reading results", err) catch {};
            return;
        };
        defer allocator.free(sarif_content);

        _ = sarif_file.readPositionalAll(self.io, sarif_content, 0) catch |err| {
            self.fail(responder, request_id, "Failed to read results", err) catch {};
            return;
        };

        // Respond with success
        responder.success(request_id, sarif_content) catch {};
    }


    fn emitLog(self: *CodeQlBridge, responder: zero_native.bridge.AsyncResponder, message: []const u8) !void {
        const runtime: *zero_native.Runtime = @ptrCast(@alignCast(responder.context));
        
        // Manual JSON construction to be safe
        const payload = std.fmt.allocPrint(self.allocator, "{{\"message\":\"{s}\"}}", .{message}) catch return;
        defer self.allocator.free(payload);
        
        try runtime.emitWindowEvent(responder.source.window_id, "codeql-log", payload);
    }


    fn fail(self: *CodeQlBridge, responder: zero_native.bridge.AsyncResponder, id: []const u8, message: []const u8, err: anyerror) !void {
        _ = self;
        var buf: [512]u8 = undefined;
        const full_message = std.fmt.bufPrint(&buf, "{s}: {s}", .{ message, @errorName(err) }) catch "Internal Error";
        responder.fail(id, .handler_failed, full_message) catch {};
    }
};

pub fn getDispatcher(allocator: std.mem.Allocator, bridge_instance: *CodeQlBridge) zero_native.BridgeDispatcher {
    const handlers = allocator.alloc(zero_native.bridge.AsyncHandler, 1) catch @panic("OOM");
    handlers[0] = .{
        .name = "codeql.runScan",
        .context = bridge_instance,
        .invoke_fn = CodeQlBridge.runScan,
    };

    return .{
        .policy = .{ .enabled = true, .commands = &.{
            .{ .name = "codeql.runScan", .origins = &.{"*"} },
        } },
        .async_registry = .{ .handlers = handlers },
    };
}
