const std = @import("std");
const zero_native = @import("zero-native");

pub const FirebaseBridge = struct {
    allocator: std.mem.Allocator,
    io: std.Io,

    pub fn init(allocator: std.mem.Allocator, io: std.Io) FirebaseBridge {
        return .{ .allocator = allocator, .io = io };
    }

    const SaveTokenPayload = struct {
        token: []const u8,
    };

    fn resolveCandidatePath(allocator: std.mem.Allocator, io: std.Io, exe_dir_path: []const u8, filename: []const u8) ?[]const u8 {
        const base_candidates = &[_][]const u8{
            "../../",
            "../../../",
            "../../../../",
            "../",
            "",
        };

        for (base_candidates) |base| {
            const candidate = std.fs.path.join(allocator, &.{ base, filename }) catch continue;
            defer allocator.free(candidate);
            const joined_path = std.fs.path.join(allocator, &.{ exe_dir_path, candidate }) catch continue;
            
            if (std.Io.Dir.openFileAbsolute(io, joined_path, .{})) |f| {
                f.close(io);
                return joined_path;
            } else |_| {
                allocator.free(joined_path);
            }
        }
        return null;
    }

    pub fn saveToken(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
        const self: *FirebaseBridge = @ptrCast(@alignCast(context));

        var req: SaveTokenPayload = undefined;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();

        if (std.json.parseFromSlice(SaveTokenPayload, arena.allocator(), invocation.request.payload, .{ .ignore_unknown_fields = true })) |parsed| {
            req = parsed.value;
        } else |err| {
            std.debug.print("[Error] Failed to parse saveToken request: {s}\n", .{@errorName(err)});
            responder.fail(invocation.request.id, .handler_failed, "Invalid request payload") catch {};
            return;
        }

        const token = req.token;
        if (token.len == 0) {
            responder.fail(invocation.request.id, .handler_failed, "Token is empty") catch {};
            return;
        }

        var exe_path_buf: [std.fs.max_path_bytes]u8 = undefined;
        const exe_path_len = std.Io.Dir.readLinkAbsolute(self.io, "/proc/self/exe", &exe_path_buf) catch {
            responder.fail(invocation.request.id, .handler_failed, "Failed to resolve exe path") catch {};
            return;
        };
        const exe_dir_path = std.fs.path.dirname(exe_path_buf[0..exe_path_len]) orelse ".";
        
        // We always save relative to the project root assuming executable is in zig-out/bin
        const token_file_path = std.fs.path.join(self.allocator, &.{ exe_dir_path, "../../firebase_token.txt" }) catch return;
        defer self.allocator.free(token_file_path);

        var file = std.Io.Dir.createFileAbsolute(self.io, token_file_path, .{}) catch |err| {
            std.debug.print("[Error] Failed to open token file: {s}\n", .{@errorName(err)});
            responder.fail(invocation.request.id, .handler_failed, "Failed to save token") catch {};
            return;
        };
        defer file.close(self.io);

        file.writePositionalAll(self.io, token, 0) catch |err| {
            std.debug.print("[Error] Failed to write token file: {s}\n", .{@errorName(err)});
            responder.fail(invocation.request.id, .handler_failed, "Failed to write token") catch {};
            return;
        };

        std.debug.print("[Firebase] Token saved successfully.\n", .{});
        responder.success(invocation.request.id, "{\"success\":true}") catch {};
    }

    const SendPushPayload = struct {
        title: []const u8,
        body: []const u8,
    };

    pub fn sendPush(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
        const self: *FirebaseBridge = @ptrCast(@alignCast(context));
        
        var req: SendPushPayload = undefined;
        var arena = std.heap.ArenaAllocator.init(self.allocator);
        defer arena.deinit();

        if (std.json.parseFromSlice(SendPushPayload, arena.allocator(), invocation.request.payload, .{ .ignore_unknown_fields = true })) |parsed| {
            req = parsed.value;
        } else |err| {
            std.debug.print("[Error] Failed to parse sendPush request: {s}\n", .{@errorName(err)});
            responder.fail(invocation.request.id, .handler_failed, "Invalid request payload") catch {};
            return;
        }

        var exe_path_buf: [std.fs.max_path_bytes]u8 = undefined;
        const exe_path_len = std.Io.Dir.readLinkAbsolute(self.io, "/proc/self/exe", &exe_path_buf) catch {
            responder.fail(invocation.request.id, .handler_failed, "Failed to resolve exe path") catch {};
            return;
        };
        const exe_dir_path = std.fs.path.dirname(exe_path_buf[0..exe_path_len]) orelse ".";

        const token_file_path = resolveCandidatePath(self.allocator, self.io, exe_dir_path, "firebase_token.txt") orelse {
            std.debug.print("[Warning] firebase_token.txt not found. Cannot send notification.\n", .{});
            responder.fail(invocation.request.id, .handler_failed, "Token file not found") catch {};
            return;
        };
        defer self.allocator.free(token_file_path);

        var file = std.Io.Dir.openFileAbsolute(self.io, token_file_path, .{}) catch {
            responder.fail(invocation.request.id, .handler_failed, "Failed to open token") catch {};
            return;
        };
        defer file.close(self.io);

        const file_size = (file.stat(self.io) catch return).size;
        if (file_size == 0) return;

        const token_buf = self.allocator.alloc(u8, file_size) catch return;
        defer self.allocator.free(token_buf);

        _ = file.readPositionalAll(self.io, token_buf, 0) catch {
            return;
        };
        const token = token_buf;

        const script_path = resolveCandidatePath(self.allocator, self.io, exe_dir_path, "scripts/firebase_push/send.js") orelse {
            std.debug.print("[Error] Failed to locate send.js script\n", .{});
            responder.fail(invocation.request.id, .handler_failed, "Script not found") catch {};
            return;
        };
        defer self.allocator.free(script_path);
        
        std.debug.print("[Firebase] Sending dynamic notification...\n", .{});
        
        const result = std.process.run(self.allocator, self.io, .{
            .argv = &.{ "node", script_path, token, req.title, req.body },
        }) catch |err| {
            std.debug.print("[Error] Failed to execute Node script: {s}\n", .{@errorName(err)});
            responder.fail(invocation.request.id, .handler_failed, "Node error") catch {};
            return;
        };
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        if (result.term != .exited or result.term.exited != 0) {
            std.debug.print("[Error] Firebase push script failed.\nStdout: {s}\nStderr: {s}\n", .{ result.stdout, result.stderr });
            responder.fail(invocation.request.id, .handler_failed, "Script error") catch {};
        } else {
            std.debug.print("[Success] Firebase push delivered: {s}\n", .{result.stdout});
            responder.success(invocation.request.id, "{\"success\":true}") catch {};
        }
    }
};

pub fn getDispatcher(allocator: std.mem.Allocator, bridge_instance: *FirebaseBridge) zero_native.BridgeDispatcher {
    const handlers = allocator.alloc(zero_native.bridge.AsyncHandler, 2) catch @panic("OOM");
    handlers[0] = .{
        .name = "firebase.saveToken",
        .context = bridge_instance,
        .invoke_fn = FirebaseBridge.saveToken,
    };
    handlers[1] = .{
        .name = "firebase.sendPush",
        .context = bridge_instance,
        .invoke_fn = FirebaseBridge.sendPush,
    };

    return .{
        .policy = .{ .enabled = true, .commands = &.{
            .{ .name = "firebase.saveToken", .origins = &.{"*"} },
            .{ .name = "firebase.sendPush", .origins = &.{"*"} },
        } },
        .async_registry = .{ .handlers = handlers },
    };
}
