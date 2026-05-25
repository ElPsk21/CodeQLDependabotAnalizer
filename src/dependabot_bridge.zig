const std = @import("std");
const zero_native = @import("zero-native");

pub const DependabotBridge = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    dependabot_cli_path: []const u8 = "",

    pub fn init(allocator: std.mem.Allocator, io: std.Io) DependabotBridge {
        return .{ .allocator = allocator, .io = io };
    }

    const ScanArgs = struct {
        self: *DependabotBridge,
        path: []const u8,
        ecosystem: []const u8,
        directory: []const u8,
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

        var ecosystem: []const u8 = "npm_and_yarn";
        const eco_key = "\"ecosystem\":\"";
        if (std.mem.indexOf(u8, invocation.request.payload, eco_key)) |e_start_idx| {
            const e_start = e_start_idx + eco_key.len;
            if (std.mem.indexOfScalarPos(u8, invocation.request.payload, e_start, '"')) |e_end| {
                ecosystem = invocation.request.payload[e_start..e_end];
            }
        }

        var directory: []const u8 = "/";
        const dir_key = "\"directory\":\"";
        if (std.mem.indexOf(u8, invocation.request.payload, dir_key)) |d_start_idx| {
            const d_start = d_start_idx + dir_key.len;
            if (std.mem.indexOfScalarPos(u8, invocation.request.payload, d_start, '"')) |d_end| {
                directory = invocation.request.payload[d_start..d_end];
            }
        }

        const project_path_copy = try self.allocator.dupe(u8, project_path);
        const ecosystem_copy = try self.allocator.dupe(u8, ecosystem);
        const directory_copy = try self.allocator.dupe(u8, directory);
        const request_id_copy = try self.allocator.dupe(u8, invocation.request.id);

        const args = try self.allocator.create(ScanArgs);
        args.* = .{ .self = self, .path = project_path_copy, .ecosystem = ecosystem_copy, .directory = directory_copy, .id = request_id_copy, .responder = responder };

        const thread = try std.Thread.spawn(.{}, runScanInternal, .{args});
        thread.detach();
    }

    fn runScanInternal(args: *ScanArgs) void {
        const self = args.self;
        const project_path = args.path;
        const ecosystem = args.ecosystem;
        const directory = args.directory;
        const request_id = args.id;
        const responder = args.responder;
        const allocator = self.allocator;
        
        defer allocator.free(project_path);
        defer allocator.free(ecosystem);
        defer allocator.free(directory);
        defer allocator.free(request_id);
        defer allocator.destroy(args);

        self.emitLog(responder, "[Dependabot] Starting dependency scan...") catch {};

        // Resolve script path dynamically
        var exe_path_buf: [std.fs.max_path_bytes]u8 = undefined;
        const exe_path_len = std.Io.Dir.readLinkAbsolute(self.io, "/proc/self/exe", &exe_path_buf) catch {
            self.fail(responder, request_id, "Failed to resolve exe path", error.Unexpected) catch {};
            return;
        };
        const exe_dir_path = std.fs.path.dirname(exe_path_buf[0..exe_path_len]) orelse ".";

        const candidates = &[_][]const u8{
            "../../scripts/dependabot_runner.py",
            "../../../../scripts/dependabot_runner.py",
            "../scripts/dependabot_runner.py",
            "/home/frano/my_app/scripts/dependabot_runner.py",
        };

        var resolved_script_path: ?[]const u8 = null;
        for (candidates) |candidate| {
            const joined_path = if (std.fs.path.isAbsolute(candidate))
                allocator.dupe(u8, candidate) catch {
                    self.fail(responder, request_id, "OOM building script path", error.OutOfMemory) catch {};
                    return;
                }
            else
                std.fs.path.join(allocator, &.{ exe_dir_path, candidate }) catch {
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
            self.fail(responder, request_id, "Failed to locate dependabot_runner.py script", error.FileNotFound) catch {};
            return;
        };
        defer allocator.free(script_path);

        // Parse optional dependabotCliPath from the payload
        var dep_cli_path: []const u8 = "";
        if (self.dependabot_cli_path.len > 0) {
            dep_cli_path = self.dependabot_cli_path;
        }

        const result = if (dep_cli_path.len > 0)
            std.process.run(allocator, self.io, .{
                .argv = &.{ script_path, project_path, ecosystem, directory, dep_cli_path },
            }) catch |err| {
                std.debug.print("[Error] Failed to start Dependabot script: {s}\n", .{@errorName(err)});
                self.fail(responder, request_id, "Failed to run dependabot script", err) catch {};
                return;
            }
        else
            std.process.run(allocator, self.io, .{
                .argv = &.{ script_path, project_path, ecosystem, directory },
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
