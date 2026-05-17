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
            std.debug.print("[Debug] Executing CodeQL at: {s}\n", .{self.codeql_path});
            std.debug.print("[Debug] Project path: {s}\n", .{project_path});
            std.debug.print("[Debug] DB path: {s}\n", .{db_full_path});

            const result = std.process.run(allocator, self.io, .{
                .argv = &.{ self.codeql_path, "database", "create", db_full_path, "--source-root", project_path, "--language=javascript", "--overwrite" },
            }) catch |err| {
                std.debug.print("[Error] Failed to start CodeQL process: {s}\n", .{@errorName(err)});
                self.fail(responder, request_id, "Failed to run database create", err) catch {};
                return;
            };
            defer allocator.free(result.stdout);
            defer allocator.free(result.stderr);

            if (result.term != .exited or result.term.exited != 0) {
                std.debug.print("[Error] CodeQL database create failed.\nStdout: {s}\nStderr: {s}\n", .{result.stdout, result.stderr});
                self.fail(responder, request_id, "CodeQL database create failed", error.ChildProcessFailed) catch {};
                return;
            }
            std.debug.print("[Success] CodeQL database created at {s}\n", .{db_full_path});
        }

        // 2. Database Analyze
        {
            self.emitLog(responder, "[CodeQL] Analyzing database...") catch {};
            std.debug.print("[Debug] Analyzing DB at: {s}\n", .{db_full_path});
            std.debug.print("[Debug] Output SARIF at: {s}\n", .{sarif_path});

            const result = std.process.run(allocator, self.io, .{
                .argv = &.{ self.codeql_path, "database", "analyze", db_full_path, "--format=sarif-latest", "--output", sarif_path },
            }) catch |err| {
                std.debug.print("[Error] Failed to start analysis: {s}\n", .{@errorName(err)});
                self.fail(responder, request_id, "Failed to run database analyze", err) catch {};
                return;
            };
            defer allocator.free(result.stdout);
            defer allocator.free(result.stderr);

            if (result.term != .exited or result.term.exited != 0) {
                std.debug.print("[Error] CodeQL analysis failed.\nStdout: {s}\nStderr: {s}\n", .{ result.stdout, result.stderr });
                self.fail(responder, request_id, "CodeQL analysis failed", error.ChildProcessFailed) catch {};
                return;
            }
            // Verify file exists and get size safely using self.io
            const file = std.Io.Dir.openFileAbsolute(self.io, sarif_path, .{}) catch |e| {
                std.debug.print("[Error] Could not verify results file: {s}\n", .{@errorName(e)});
                return;
            };
            defer file.close(self.io);
            const stat = file.stat(self.io) catch |e| {
                std.debug.print("[Error] Could not stat results file: {s}\n", .{@errorName(e)});
                return;
            };
            std.debug.print("[Success] Analysis complete. Result size: {d} bytes\n", .{stat.size});
        }

        // 3. Read and Parse results
        std.debug.print("[Debug] Reading results from {s}...\n", .{sarif_path});
        const sarif_file = std.Io.Dir.openFileAbsolute(self.io, sarif_path, .{}) catch |err| {
            std.debug.print("[Error] Failed to open results file: {s}\n", .{@errorName(err)});
            self.fail(responder, request_id, "Failed to open results", err) catch {};
            return;
        };
        defer sarif_file.close(self.io);

        const sarif_stat = sarif_file.stat(self.io) catch |err| {
            std.debug.print("[Error] Failed to stat results file: {s}\n", .{@errorName(err)});
            self.fail(responder, request_id, "Failed to stat results", err) catch {};
            return;
        };

        const sarif_data = allocator.alloc(u8, sarif_stat.size) catch |err| {
            self.fail(responder, request_id, "OOM reading results", err) catch {};
            return;
        };
        defer allocator.free(sarif_data);

        _ = sarif_file.readPositionalAll(self.io, sarif_data, 0) catch |err| {
            std.debug.print("[Error] Failed to read results file: {s}\n", .{@errorName(err)});
            self.fail(responder, request_id, "Failed to read results", err) catch {};
            return;
        };
        
        std.debug.print("[Success] Results read: {d} bytes\n", .{sarif_data.len});

        self.emitLog(responder, "[CodeQL] Analysis complete. Parsing results...") catch {};

        // 4. Return structured JSON
        responder.success(request_id, sarif_data) catch |err| {
            std.debug.print("[Error] Failed to send success response: {s}\n", .{@errorName(err)});
            return;
        };

        std.debug.print("[Success] Results delivered to UI via IPC.\n", .{});
        self.emitLog(responder, "[CodeQL] Done. Results delivered.") catch {};
    }


    fn emitLog(self: *CodeQlBridge, responder: zero_native.bridge.AsyncResponder, message: []const u8) !void {
        const runtime: *zero_native.Runtime = @ptrCast(@alignCast(responder.context));
        
        // Use a more robust way to send log messages without manual JSON framing if possible,
        // but since we need a JSON payload for the event:
        const payload = std.fmt.allocPrint(self.allocator, "{{\"message\":\"{s}\"}}", .{message}) catch return;
        defer self.allocator.free(payload);
        
        runtime.emitWindowEvent(responder.source.window_id, "codeql-log", payload) catch |err| {
            std.debug.print("[Error] emitWindowEvent failed: {s}\n", .{@errorName(err)});
        };
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
