const std = @import("std");
const zero_native = @import("zero-native");

pub const CopilotBridge = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    copilot_cli_path: []const u8 = "",

    pub fn init(allocator: std.mem.Allocator, io: std.Io) CopilotBridge {
        return .{
            .allocator = allocator,
            .io = io,
        };
    }

    fn fail(self: *CopilotBridge, responder: zero_native.bridge.AsyncResponder, request_id: []const u8, message: []const u8, err: anyerror) void {
        const full_msg = std.fmt.allocPrint(self.allocator, "{s}: {s}", .{ message, @errorName(err) }) catch {
            responder.fail(request_id, .handler_failed, message) catch {};
            return;
        };
        defer self.allocator.free(full_msg);
        responder.fail(request_id, .handler_failed, full_msg) catch {};
    }

    fn emitLog(self: *CopilotBridge, responder: zero_native.bridge.AsyncResponder, message: []const u8) !void {
        const runtime: *zero_native.Runtime = @ptrCast(@alignCast(responder.context));
        
        var json_out = std.ArrayListUnmanaged(u8){ .items = &.{}, .capacity = 0 };
        defer json_out.deinit(self.allocator);
        
        json_out.appendSlice(self.allocator, "{\"message\":") catch return;
        escapeJsonString(self.allocator, message, &json_out) catch return;
        json_out.appendSlice(self.allocator, "}") catch return;
        
        runtime.emitWindowEvent(responder.source.window_id, "copilot-log", json_out.items) catch |err| {
            std.debug.print("[Error] emitWindowEvent failed: {s}\n", .{@errorName(err)});
        };
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

    const ResolveArgs = struct {
        self: *CopilotBridge,
        request_id: []const u8,
        responder: zero_native.bridge.AsyncResponder,
        project_path: []const u8,
        prompt: []const u8,
    };

    const LoginArgs = struct {
        self: *CopilotBridge,
        request_id: []const u8,
        responder: zero_native.bridge.AsyncResponder,
    };

    pub fn login(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
        const self: *CopilotBridge = @ptrCast(@alignCast(context));
        const allocator = self.allocator;
        const request_id = try allocator.dupe(u8, invocation.request.id);

        const args = try allocator.create(LoginArgs);
        args.* = .{
            .self = self,
            .request_id = request_id,
            .responder = responder,
        };

        const thread = try std.Thread.spawn(.{}, loginInternal, .{args});
        thread.detach();
    }

    fn loginInternal(args: *LoginArgs) void {
        const self = args.self;
        const allocator = self.allocator;
        const request_id = args.request_id;
        const responder = args.responder;

        defer {
            allocator.free(request_id);
            allocator.destroy(args);
        }

        const bin = if (self.copilot_cli_path.len > 0) self.copilot_cli_path else "copilot";
        const cmd = std.fmt.allocPrint(allocator, "exec {s} login", .{bin}) catch return;
        defer allocator.free(cmd);

        var child = std.process.spawn(self.io, .{
            .argv = &.{ "script", "-e", "-q", "-c", cmd, "/dev/null" },
            .stdin = .pipe,
            .stdout = .pipe,
            .stderr = .pipe,
        }) catch |err| {
            self.fail(responder, request_id, "Failed to spawn copilot login", err);
            return;
        };

        const stdout = child.stdout.?;
        const stdin = child.stdin.?;
        
        var line_buf = std.ArrayListUnmanaged(u8){ .items = &.{}, .capacity = 0 };
        defer line_buf.deinit(allocator);

        while (true) {
            var byte: [1]u8 = undefined;
            const bytes_read = stdout.readStreaming(self.io, &.{&byte}) catch 0;
            if (bytes_read == 0) break;
            
            if (byte[0] == '\n') {
                self.emitLog(responder, line_buf.items) catch {};
                line_buf.clearRetainingCapacity();
            } else if (byte[0] != '\r') {
                line_buf.append(allocator, byte[0]) catch {};
                
                if (std.mem.indexOf(u8, line_buf.items, "(y/N)") != null or 
                    std.mem.indexOf(u8, line_buf.items, "(Y/n)") != null or 
                    std.mem.indexOf(u8, line_buf.items, "(y/n)") != null) {
                    self.emitLog(responder, line_buf.items) catch {};
                    line_buf.clearRetainingCapacity();
                    stdin.writeStreamingAll(self.io, "y\n") catch {};
                }
            }
        }
        if (line_buf.items.len > 0) {
            self.emitLog(responder, line_buf.items) catch {};
        }

        const term = child.wait(self.io) catch |err| {
            self.fail(responder, request_id, "Failed to wait for copilot login", err);
            return;
        };

        if (term != .exited or term.exited != 0) {
            responder.success(request_id, "{\"success\":false}") catch {};
        } else {
            responder.success(request_id, "{\"success\":true}") catch {};
        }
    }


    pub fn resolveIssues(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
        const self: *CopilotBridge = @ptrCast(@alignCast(context));
        const allocator = self.allocator;
        const request_id = try allocator.dupe(u8, invocation.request.id);

        var project_path: []const u8 = "";
        var prompt: []const u8 = "";

        // Parse projectPath and prompt
        const proj_key = "\"projectPath\":\"";
        if (std.mem.indexOf(u8, invocation.request.payload, proj_key)) |idx| {
            const start = idx + proj_key.len;
            if (std.mem.indexOfScalarPos(u8, invocation.request.payload, start, '"')) |end| {
                project_path = try allocator.dupe(u8, invocation.request.payload[start..end]);
            }
        }

        // Extremely simple parsing for prompt to handle \n escapes
        var parsed_prompt = std.ArrayListUnmanaged(u8){ .items = &.{}, .capacity = 0 };
        const prompt_key = "\"prompt\":\"";
        if (std.mem.indexOf(u8, invocation.request.payload, prompt_key)) |idx| {
            const start = idx + prompt_key.len;
            var i = start;
            while (i < invocation.request.payload.len) : (i += 1) {
                const c = invocation.request.payload[i];
                if (c == '"') break;
                if (c == '\\' and i + 1 < invocation.request.payload.len) {
                    const next = invocation.request.payload[i + 1];
                    if (next == 'n') {
                        try parsed_prompt.append(allocator, '\n');
                        i += 1;
                        continue;
                    }
                }
                try parsed_prompt.append(allocator, c);
            }
        }
        prompt = try parsed_prompt.toOwnedSlice(allocator);

        const args = try allocator.create(ResolveArgs);
        args.* = .{
            .self = self,
            .request_id = request_id,
            .responder = responder,
            .project_path = project_path,
            .prompt = prompt,
        };

        const thread = try std.Thread.spawn(.{}, resolveInternal, .{args});
        thread.detach();
    }

    fn resolveInternal(args: *ResolveArgs) void {
        const self = args.self;
        const allocator = self.allocator;
        const request_id = args.request_id;
        const responder = args.responder;
        const prompt = args.prompt;
        const project_path = args.project_path;

        // Cleanup prompt and project_path memory when the function exits
        defer {
            if (prompt.len > 0) allocator.free(prompt);
            if (project_path.len > 0) allocator.free(project_path);
            allocator.free(request_id);
            allocator.destroy(args);
        }

        const bin = if (self.copilot_cli_path.len > 0) self.copilot_cli_path else "copilot";

        const script =
            \\if [ -n "$1" ]; then cd "$1" || exit 1; fi
            \\exec "$2" -p "$3" -s
        ;

        // Run through bash login shell so it inherits the user's full PATH (e.g. NVM).
        // Passing arguments as positional parameters avoids quotes injection and quoting hell.
        const result = std.process.run(allocator, self.io, .{
            .argv = &.{ "bash", "-lc", script, "bash", project_path, bin, prompt },
            .cwd = .inherit,
        }) catch |err| {
            self.fail(responder, request_id, "Failed to run copilot", err);
            return;
        };
        defer allocator.free(result.stdout);
        defer allocator.free(result.stderr);

        // Check if authentication error (heuristic)
        if (std.mem.indexOf(u8, result.stderr, "Please log in") != null or 
            std.mem.indexOf(u8, result.stderr, "Not authenticated") != null or 
            std.mem.indexOf(u8, result.stdout, "Please log in") != null) 
        {
            const out_json = "{\"needsAuth\":true,\"error\":\"Not authenticated\"}";
            responder.success(request_id, out_json) catch {};
            return;
        }
        
        if (result.term != .exited or result.term.exited != 0) {
            std.debug.print("Copilot error: {s}\n", .{result.stderr});
            if (std.mem.indexOf(u8, result.stderr, "Authentication") != null or 
                std.mem.indexOf(u8, result.stderr, "token") != null or 
                std.mem.indexOf(u8, result.stderr, "auth") != null) 
            {
                const out_json = "{\"needsAuth\":true,\"error\":\"Authentication failed or token invalid\"}";
                responder.success(request_id, out_json) catch {};
                return;
            }
        }

        const final_out = if (result.term == .exited and result.term.exited == 0) result.stdout else result.stderr;
        
        var json_out = std.ArrayListUnmanaged(u8){ .items = &.{}, .capacity = 0 };
        defer json_out.deinit(allocator);
        json_out.appendSlice(allocator, "{\"needsAuth\":false,\"output\":") catch return;
        escapeJsonString(allocator, final_out, &json_out) catch return;
        json_out.appendSlice(allocator, "}") catch return;

        responder.success(request_id, json_out.items) catch {};
    }
};
