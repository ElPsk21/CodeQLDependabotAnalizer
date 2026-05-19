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

    const SnippetArgs = struct {
        self: *CodeQlBridge,
        path: []const u8,
        startLine: u32,
        endLine: u32,
        id: []const u8,
        responder: zero_native.bridge.AsyncResponder,
    };

    pub fn readSnippet(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
        const self: *CodeQlBridge = @ptrCast(@alignCast(context));

        std.debug.print("[Debug] readSnippet payload: {s}\n", .{invocation.request.payload});

        const RequestPayload = struct {
            path: []const u8,
            startLine: u32,
            endLine: u32,
        };

        var req: RequestPayload = undefined;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();

        if (std.json.parseFromSlice(RequestPayload, arena.allocator(), invocation.request.payload, .{ .ignore_unknown_fields = true })) |parsed| {
            req = parsed.value;
        } else |err1| {
            if (std.json.parseFromSlice([]RequestPayload, arena.allocator(), invocation.request.payload, .{ .ignore_unknown_fields = true })) |parsed_arr| {
                if (parsed_arr.value.len > 0) {
                    req = parsed_arr.value[0];
                } else {
                    std.debug.print("[Error] Empty array payload: {s}\n", .{@errorName(err1)});
                    responder.fail(invocation.request.id, .handler_failed, "Invalid empty array payload") catch {};
                    return;
                }
            } else |err2| {
                std.debug.print("[Error] Failed to parse readSnippet request: {s} and {s}. Payload: {s}\n", .{ @errorName(err1), @errorName(err2), invocation.request.payload });
                responder.fail(invocation.request.id, .handler_failed, "Invalid request payload") catch {};
                return;
            }
        }

        // Duplicate data for the thread since invocation will be freed after handler returns
        const path_copy = try self.allocator.dupe(u8, req.path);
        const id_copy = try self.allocator.dupe(u8, invocation.request.id);

        const args = try self.allocator.create(SnippetArgs);
        args.* = .{
            .self = self,
            .path = path_copy,
            .startLine = req.startLine,
            .endLine = req.endLine,
            .id = id_copy,
            .responder = responder,
        };

        const thread = try std.Thread.spawn(.{}, readSnippetInternal, .{args});
        thread.detach();
    }
    fn escapeJsonString(allocator: std.mem.Allocator, input: []const u8, out: *std.ArrayListUnmanaged(u8)) !void {
        try out.appendSlice(allocator, "\"");
        for (input) |c| {
            switch (c) {
                '"' => try out.appendSlice(allocator, "\\\""),
                '\\' => try out.appendSlice(allocator, "\\\\"),
                '\n' => try out.appendSlice(allocator, "\\n"),
                '\r' => try out.appendSlice(allocator, "\\r"),
                '\t' => try out.appendSlice(allocator, "\\t"),
                else => try out.append(allocator, c),
            }
        }
        try out.appendSlice(allocator, "\"");
    }

    fn readSnippetInternal(args: *SnippetArgs) void {
        const self = args.self;
        const allocator = self.allocator;
        const responder = args.responder;
        const request_id = args.id;

        defer allocator.free(args.path);
        defer allocator.free(request_id);
        defer allocator.destroy(args);

        const file = std.Io.Dir.openFileAbsolute(self.io, args.path, .{}) catch |err| {
            std.debug.print("[Error] Failed to open file {s}: {s}\n", .{ args.path, @errorName(err) });
            responder.fail(request_id, .handler_failed, "Failed to open file") catch {};
            return;
        };
        defer file.close(self.io);

        var out_list = std.ArrayListUnmanaged(u8){ .items = &.{}, .capacity = 0 };
        defer out_list.deinit(allocator);

        const file_size = (file.stat(self.io) catch |err| {
            responder.fail(request_id, .handler_failed, @errorName(err)) catch {};
            return;
        }).size;
        const file_content = allocator.alloc(u8, file_size) catch |err| {
            responder.fail(request_id, .handler_failed, @errorName(err)) catch {};
            return;
        };
        defer allocator.free(file_content);

        _ = file.readPositionalAll(self.io, file_content, 0) catch |err| {
            responder.fail(request_id, .handler_failed, @errorName(err)) catch {};
            return;
        };

        var current_line: u32 = 1;
        var it = std.mem.splitScalar(u8, file_content, '\n');

        while (it.next()) |line| {
            if (current_line >= args.startLine and current_line <= args.endLine) {
                std.debug.print("[Debug] Line {d}: {s}\n", .{ current_line, line });
                out_list.appendSlice(allocator, line) catch return;
                out_list.append(allocator, '\n') catch return;
            }
            if (current_line > args.endLine) break;
            current_line += 1;
        }

        std.debug.print("[Debug] Snippet gathered ({d} bytes). Sending success...\n", .{out_list.items.len});
        
        // Wrap the snippet in JSON so zero_native doesn't send malformed IPC messages
        var json_out = std.ArrayListUnmanaged(u8){ .items = &.{}, .capacity = 0 };
        defer json_out.deinit(allocator);

        json_out.appendSlice(allocator, "{\"content\":") catch return;
        escapeJsonString(allocator, out_list.items, &json_out) catch return;
        json_out.appendSlice(allocator, "}") catch return;

        responder.success(request_id, json_out.items) catch |err| {
            std.debug.print("[Error] Failed to send snippet success: {s}\n", .{@errorName(err)});
        };
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
    const handlers = allocator.alloc(zero_native.bridge.AsyncHandler, 2) catch @panic("OOM");
    handlers[0] = .{
        .name = "codeql.runScan",
        .context = bridge_instance,
        .invoke_fn = CodeQlBridge.runScan,
    };
    handlers[1] = .{
        .name = "codeql.readSnippet",
        .context = bridge_instance,
        .invoke_fn = CodeQlBridge.readSnippet,
    };

    return .{
        .policy = .{ .enabled = true, .commands = &.{
            .{ .name = "codeql.runScan", .origins = &.{"*"} },
            .{ .name = "codeql.readSnippet", .origins = &.{"*"} },
        } },
        .async_registry = .{ .handlers = handlers },
    };
}
