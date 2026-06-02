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
            "../../../scripts/dependabot_runner.py",
            "../../../../scripts/dependabot_runner.py",
            "../scripts/dependabot_runner.py",
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

    fn escapeJsonString(allocator: std.mem.Allocator, input: []const u8, out: *std.ArrayListUnmanaged(u8)) !void {
        try out.appendSlice(allocator, "\"");
        for (input) |c| {
            switch (c) {
                '"' => try out.appendSlice(allocator, "\\\""),
                '\\' => try out.appendSlice(allocator, "\\\\"),
                '\n' => try out.appendSlice(allocator, "\\n"),
                '\r' => try out.appendSlice(allocator, "\\r"),
                '\t' => try out.appendSlice(allocator, "\\t"),
                0x1B => try out.appendSlice(allocator, "\\u001b"),
                else => try out.append(allocator, c),
            }
        }
        try out.appendSlice(allocator, "\"");
    }

    // --- Update Dependencies ---

    const UpdateArgs = struct {
        self: *DependabotBridge,
        request_id: []const u8,
        project_path: []const u8,
        updates_json: []const u8,
        responder: zero_native.bridge.AsyncResponder,
    };

    pub fn updateDeps(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
        const self: *DependabotBridge = @ptrCast(@alignCast(context));
        const allocator = self.allocator;

        const request_id = try allocator.dupe(u8, invocation.request.id);
        const payload_copy = try allocator.dupe(u8, invocation.request.payload);

        // Extract projectPath
        var project_path: []const u8 = "";
        const pp_key = "\"projectPath\":\"";
        if (std.mem.indexOf(u8, invocation.request.payload, pp_key)) |pp_start_idx| {
            const pp_start = pp_start_idx + pp_key.len;
            if (std.mem.indexOfScalarPos(u8, invocation.request.payload, pp_start, '"')) |pp_end| {
                project_path = try allocator.dupe(u8, invocation.request.payload[pp_start..pp_end]);
            }
        }

        if (project_path.len == 0) {
            allocator.free(request_id);
            allocator.free(payload_copy);
            self.fail(responder, invocation.request.id, "Missing projectPath", error.InvalidRequest) catch {};
            return;
        }

        const args = try allocator.create(UpdateArgs);
        args.* = .{
            .self = self,
            .request_id = request_id,
            .project_path = project_path,
            .updates_json = payload_copy,
            .responder = responder,
        };

        const thread = try std.Thread.spawn(.{}, updateDepsInternal, .{args});
        thread.detach();
    }

    fn updateDepsInternal(args: *UpdateArgs) void {
        const self = args.self;
        const allocator = self.allocator;
        const request_id = args.request_id;
        const project_path = args.project_path;
        const updates_json = args.updates_json;
        const responder = args.responder;

        defer {
            allocator.free(request_id);
            allocator.free(project_path);
            allocator.free(updates_json);
            allocator.destroy(args);
        }

        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const aa = arena.allocator();

        // Detect ecosystem by scanning files in the project
        const ecosystem = detectEcosystem(self, project_path);

        std.debug.print("[updateDeps] Ecosystem: {s}, Project: {s}\n", .{ecosystem, project_path});

        // Parse updates from the JSON payload manually using simple string search
        // Format: {"projectPath":"...","updates":[{"package":"name","version":"ver"},...]}}
        var applied = std.ArrayListUnmanaged([]const u8){ .items = &.{}, .capacity = 0 };
        var errors_list = std.ArrayListUnmanaged([]const u8){ .items = &.{}, .capacity = 0 };

        // Find each {"package":"...","version":"..."} in the updates array
        var search_pos: usize = 0;
        const pkg_key = "\"package\":\"";
        const ver_key = "\"version\":\"";

        while (std.mem.indexOfPos(u8, updates_json, search_pos, pkg_key)) |pkg_start_idx| {
            const pkg_name_start = pkg_start_idx + pkg_key.len;
            const pkg_name_end = std.mem.indexOfScalarPos(u8, updates_json, pkg_name_start, '"') orelse break;
            const pkg_name = updates_json[pkg_name_start..pkg_name_end];

            // Find version after this package
            const ver_start_idx = std.mem.indexOfPos(u8, updates_json, pkg_name_end, ver_key) orelse break;
            const ver_name_start = ver_start_idx + ver_key.len;
            const ver_name_end = std.mem.indexOfScalarPos(u8, updates_json, ver_name_start, '"') orelse break;
            const version = updates_json[ver_name_start..ver_name_end];

            search_pos = ver_name_end + 1;

            std.debug.print("[updateDeps] Updating {s} to {s}\n", .{pkg_name, version});

            // Build and run the command based on ecosystem
            const cmd_result = buildAndRunUpdateCommand(self, aa, project_path, ecosystem, pkg_name, version);

            if (cmd_result) |_| {
                const msg = std.fmt.allocPrint(aa, "{s}@{s}", .{pkg_name, version}) catch continue;
                applied.append(aa, msg) catch {};
            } else |err| {
                const msg = std.fmt.allocPrint(aa, "{s}: {s}", .{pkg_name, @errorName(err)}) catch continue;
                errors_list.append(aa, msg) catch {};
            }
        }

        // Build JSON response
        var json_out = std.ArrayListUnmanaged(u8){ .items = &.{}, .capacity = 0 };
        json_out.appendSlice(aa, "{\"applied\":[") catch return;
        for (applied.items, 0..) |f, i| {
            if (i > 0) json_out.appendSlice(aa, ",") catch return;
            escapeJsonString(aa, f, &json_out) catch return;
        }
        json_out.appendSlice(aa, "],\"errors\":[") catch return;
        for (errors_list.items, 0..) |e, i| {
            if (i > 0) json_out.appendSlice(aa, ",") catch return;
            escapeJsonString(aa, e, &json_out) catch return;
        }
        json_out.appendSlice(aa, "]}") catch return;

        responder.success(request_id, json_out.items) catch {};
    }

    fn detectEcosystem(self: *DependabotBridge, project_path: []const u8) []const u8 {
        // Check for package.json (npm/yarn)
        const npm_check = std.fmt.allocPrint(self.allocator, "{s}/package.json", .{project_path}) catch return "unknown";
        defer self.allocator.free(npm_check);
        if (std.Io.Dir.openFileAbsolute(self.io, npm_check, .{})) |f| { f.close(self.io); return "npm"; } else |_| {}

        // Check for frontend/package.json
        const npm_fe_check = std.fmt.allocPrint(self.allocator, "{s}/frontend/package.json", .{project_path}) catch return "unknown";
        defer self.allocator.free(npm_fe_check);
        if (std.Io.Dir.openFileAbsolute(self.io, npm_fe_check, .{})) |f| { f.close(self.io); return "npm_frontend"; } else |_| {}

        // Check for .csproj (nuget/dotnet)
        const csproj_result = std.process.run(self.allocator, self.io, .{
            .argv = &.{ "bash", "-c", "find \"$1\" -maxdepth 2 -name '*.csproj' -print -quit", "bash", project_path },
        }) catch return "unknown";
        defer self.allocator.free(csproj_result.stdout);
        defer self.allocator.free(csproj_result.stderr);
        if (csproj_result.stdout.len > 0) return "nuget";

        // Check for requirements.txt (pip)
        const pip_check = std.fmt.allocPrint(self.allocator, "{s}/requirements.txt", .{project_path}) catch return "unknown";
        defer self.allocator.free(pip_check);
        if (std.Io.Dir.openFileAbsolute(self.io, pip_check, .{})) |f| { f.close(self.io); return "pip"; } else |_| {}

        // Check for pom.xml (maven)
        const mvn_check = std.fmt.allocPrint(self.allocator, "{s}/pom.xml", .{project_path}) catch return "unknown";
        defer self.allocator.free(mvn_check);
        if (std.Io.Dir.openFileAbsolute(self.io, mvn_check, .{})) |f| { f.close(self.io); return "maven"; } else |_| {}

        // Check for build.gradle (gradle)
        const gradle_check = std.fmt.allocPrint(self.allocator, "{s}/build.gradle", .{project_path}) catch return "unknown";
        defer self.allocator.free(gradle_check);
        if (std.Io.Dir.openFileAbsolute(self.io, gradle_check, .{})) |f| { f.close(self.io); return "gradle"; } else |_| {}

        // Check for Gemfile (bundler)
        const gem_check = std.fmt.allocPrint(self.allocator, "{s}/Gemfile", .{project_path}) catch return "unknown";
        defer self.allocator.free(gem_check);
        if (std.Io.Dir.openFileAbsolute(self.io, gem_check, .{})) |f| { f.close(self.io); return "bundler"; } else |_| {}

        // Check for go.mod (go)
        const go_check = std.fmt.allocPrint(self.allocator, "{s}/go.mod", .{project_path}) catch return "unknown";
        defer self.allocator.free(go_check);
        if (std.Io.Dir.openFileAbsolute(self.io, go_check, .{})) |f| { f.close(self.io); return "gomod"; } else |_| {}

        // Check for Cargo.toml (cargo/rust)
        const cargo_check = std.fmt.allocPrint(self.allocator, "{s}/Cargo.toml", .{project_path}) catch return "unknown";
        defer self.allocator.free(cargo_check);
        if (std.Io.Dir.openFileAbsolute(self.io, cargo_check, .{})) |f| { f.close(self.io); return "cargo"; } else |_| {}

        // Check for composer.json (PHP/composer)
        const composer_check = std.fmt.allocPrint(self.allocator, "{s}/composer.json", .{project_path}) catch return "unknown";
        defer self.allocator.free(composer_check);
        if (std.Io.Dir.openFileAbsolute(self.io, composer_check, .{})) |f| { f.close(self.io); return "composer"; } else |_| {}

        return "unknown";
    }

    fn buildAndRunUpdateCommand(self: *DependabotBridge, allocator: std.mem.Allocator, project_path: []const u8, ecosystem: []const u8, pkg: []const u8, version: []const u8) !void {
        var script: []const u8 = undefined;

        if (std.mem.eql(u8, ecosystem, "npm")) {
            script = try std.fmt.allocPrint(allocator, "cd \"{s}\" && npm install {s}@{s} --save", .{project_path, pkg, version});
        } else if (std.mem.eql(u8, ecosystem, "npm_frontend")) {
            script = try std.fmt.allocPrint(allocator, "cd \"{s}/frontend\" && npm install {s}@{s} --save", .{project_path, pkg, version});
        } else if (std.mem.eql(u8, ecosystem, "nuget")) {
            // Find the .csproj file first
            const find_result = std.process.run(allocator, self.io, .{
                .argv = &.{ "bash", "-c", "find \"$1\" -maxdepth 2 -name '*.csproj' -print -quit", "bash", project_path },
            }) catch return error.FileNotFound;
            defer allocator.free(find_result.stdout);
            defer allocator.free(find_result.stderr);

            var csproj = find_result.stdout;
            // Trim trailing newline
            while (csproj.len > 0 and (csproj[csproj.len - 1] == '\n' or csproj[csproj.len - 1] == '\r')) {
                csproj = csproj[0..csproj.len - 1];
            }
            if (csproj.len == 0) return error.FileNotFound;

            const dotnet_bin = if (self.dependabot_cli_path.len > 0) self.dependabot_cli_path else "dotnet";
            _ = dotnet_bin;
            script = try std.fmt.allocPrint(allocator, "cd \"{s}\" && dotnet add \"{s}\" package {s} --version {s}", .{project_path, csproj, pkg, version});
        } else if (std.mem.eql(u8, ecosystem, "pip")) {
            script = try std.fmt.allocPrint(allocator, "cd \"{s}\" && pip install {s}=={s}", .{project_path, pkg, version});
        } else if (std.mem.eql(u8, ecosystem, "maven")) {
            // Maven doesn't have a simple CLI update; use versions-maven-plugin
            script = try std.fmt.allocPrint(allocator, "cd \"{s}\" && mvn versions:use-dep-version -Dincludes={s} -DdepVersion={s} -DforceVersion=true", .{project_path, pkg, version});
        } else if (std.mem.eql(u8, ecosystem, "gradle")) {
            // Gradle: use sed to update version in build.gradle
            script = try std.fmt.allocPrint(allocator, "cd \"{s}\" && sed -i \"s/{s}:[^'\\\"]*/{s}:{s}/g\" build.gradle", .{project_path, pkg, pkg, version});
        } else if (std.mem.eql(u8, ecosystem, "bundler")) {
            script = try std.fmt.allocPrint(allocator, "cd \"{s}\" && bundle update {s} --conservative", .{project_path, pkg});
        } else if (std.mem.eql(u8, ecosystem, "gomod")) {
            script = try std.fmt.allocPrint(allocator, "cd \"{s}\" && go get {s}@v{s}", .{project_path, pkg, version});
        } else if (std.mem.eql(u8, ecosystem, "cargo")) {
            script = try std.fmt.allocPrint(allocator, "cd \"{s}\" && cargo update -p {s} --precise {s}", .{project_path, pkg, version});
        } else if (std.mem.eql(u8, ecosystem, "composer")) {
            script = try std.fmt.allocPrint(allocator, "cd \"{s}\" && composer require {s}:{s}", .{project_path, pkg, version});
        } else {
            return error.UnsupportedEcosystem;
        }
        defer allocator.free(script);

        std.debug.print("[updateDeps] Running: {s}\n", .{script});

        const result = std.process.run(allocator, self.io, .{
            .argv = &.{ "bash", "-lc", script },
            .cwd = .inherit,
        }) catch |err| {
            std.debug.print("[updateDeps] Process spawn failed: {s}\n", .{@errorName(err)});
            return err;
        };
        defer allocator.free(result.stdout);
        defer allocator.free(result.stderr);

        if (result.term != .exited or result.term.exited != 0) {
            std.debug.print("[updateDeps] Command failed. stderr: {s}\n", .{result.stderr});
            return error.CommandFailed;
        }

        std.debug.print("[updateDeps] Success: {s}@{s}\n", .{pkg, version});
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
