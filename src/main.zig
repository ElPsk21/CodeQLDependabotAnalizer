const std = @import("std");
const runner = @import("runner");
const zero_native = @import("zero-native");
const bridge = @import("bridge.zig");
const dependabot_bridge = @import("dependabot_bridge.zig");
const project_detector_bridge = @import("project_detector_bridge.zig");
const copilot_bridge = @import("copilot_bridge.zig");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

const App = struct {
    env_map: *std.process.Environ.Map,
    io: std.Io,
    codeql_bridge: bridge.CodeQlBridge,
    dependabot_bridge: dependabot_bridge.DependabotBridge,
    project_detector_bridge: project_detector_bridge.ProjectDetectorBridge,
    copilot_bridge: copilot_bridge.CopilotBridge,

    fn app(self: *@This()) zero_native.App {
        return .{
            .context = self,
            .name = "my-app",
            .source = zero_native.frontend.productionSource(.{ .dist = "frontend/dist" }),
            .source_fn = source,
        };
    }

    fn source(context: *anyopaque) anyerror!zero_native.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return zero_native.frontend.sourceFromEnv(self.env_map, .{
            .dist = "frontend/dist",
            .entry = "index.html",
        });
    }
};

pub const SystemBridge = struct {
    allocator: std.mem.Allocator,
    io: std.Io,

    pub fn init(allocator: std.mem.Allocator, io: std.Io) SystemBridge {
        return .{ .allocator = allocator, .io = io };
    }

    pub fn saveResults(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
        const self: *SystemBridge = @ptrCast(@alignCast(context));
        
        saveResultsInternal(self, invocation, responder) catch |err| {
            std.debug.print("[Error] saveResults failed: {s}\n", .{@errorName(err)});
            responder.fail(invocation.request.id, .handler_failed, @errorName(err)) catch {};
        };
    }

    fn saveResultsInternal(self: *SystemBridge, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) !void {
        // Simple parse to extract path and payload
        const path_key = "\"path\":\"";
        const start_index = std.mem.indexOf(u8, invocation.request.payload, path_key) orelse return error.InvalidRequest;
        const path_start = start_index + path_key.len;
        const end_index = std.mem.indexOfScalarPos(u8, invocation.request.payload, path_start, '"') orelse return error.InvalidRequest;
        const project_path = invocation.request.payload[path_start..end_index];

        const results_file = try std.fs.path.join(self.allocator, &.{ project_path, "scan_results.json" });
        defer self.allocator.free(results_file);

        const file = try std.Io.Dir.createFileAbsolute(self.io, results_file, .{});
        defer file.close(self.io);

        try file.writePositionalAll(self.io, invocation.request.payload, 0);

        try responder.success(invocation.request.id, "{}");
    }
};

pub const SettingsBridge = struct {
    codeql_bridge: *bridge.CodeQlBridge,
    dependabot_bridge_instance: *dependabot_bridge.DependabotBridge,
    copilot_bridge_instance: *copilot_bridge.CopilotBridge,
    allocator: std.mem.Allocator,

    pub fn updatePaths(context: *anyopaque, invocation: zero_native.bridge.Invocation, responder: zero_native.bridge.AsyncResponder) anyerror!void {
        const self: *SettingsBridge = @ptrCast(@alignCast(context));
        const payload = invocation.request.payload;

        // Parse codeqlPath
        const cql_key = "\"codeqlPath\":\"";
        if (std.mem.indexOf(u8, payload, cql_key)) |idx| {
            const start = idx + cql_key.len;
            if (std.mem.indexOfScalarPos(u8, payload, start, '"')) |end| {
                const value = payload[start..end];
                if (value.len > 0) {
                    if (self.codeql_bridge.codeql_path.len > 0) {
                        self.allocator.free(self.codeql_bridge.codeql_path);
                    }
                    const duped = try self.allocator.dupe(u8, value);
                    self.codeql_bridge.codeql_path = duped;
                    std.debug.print("[Settings] CodeQL path set to: {s}\n", .{duped});
                }
            }
        }

        // Parse dotnetPath
        const dot_key = "\"dotnetPath\":\"";
        if (std.mem.indexOf(u8, payload, dot_key)) |idx| {
            const start = idx + dot_key.len;
            if (std.mem.indexOfScalarPos(u8, payload, start, '"')) |end| {
                const value = payload[start..end];
                if (value.len > 0) {
                    if (self.codeql_bridge.dotnet_path.len > 0) {
                        self.allocator.free(self.codeql_bridge.dotnet_path);
                    }
                    const duped = try self.allocator.dupe(u8, value);
                    self.codeql_bridge.dotnet_path = duped;
                    std.debug.print("[Settings] dotnet path set to: {s}\n", .{duped});
                }
            }
        }

        // Parse dependabotCliPath
        const dep_key = "\"dependabotCliPath\":\"";
        if (std.mem.indexOf(u8, payload, dep_key)) |idx| {
            const start = idx + dep_key.len;
            if (std.mem.indexOfScalarPos(u8, payload, start, '"')) |end| {
                const value = payload[start..end];
                if (value.len > 0) {
                    if (self.dependabot_bridge_instance.dependabot_cli_path.len > 0) {
                        self.allocator.free(self.dependabot_bridge_instance.dependabot_cli_path);
                    }
                    const duped = try self.allocator.dupe(u8, value);
                    self.dependabot_bridge_instance.dependabot_cli_path = duped;
                    std.debug.print("[Settings] Dependabot CLI path set to: {s}\n", .{duped});
                }
            }
        }

        // Parse copilotCliPath
        const cop_key = "\"copilotCliPath\":\"";
        if (std.mem.indexOf(u8, payload, cop_key)) |idx| {
            const start = idx + cop_key.len;
            if (std.mem.indexOfScalarPos(u8, payload, start, '"')) |end| {
                const value = payload[start..end];
                if (value.len > 0) {
                    if (self.copilot_bridge_instance.copilot_cli_path.len > 0) {
                        self.allocator.free(self.copilot_bridge_instance.copilot_cli_path);
                    }
                    const duped = try self.allocator.dupe(u8, value);
                    self.copilot_bridge_instance.copilot_cli_path = duped;
                    std.debug.print("[Settings] Copilot CLI path set to: {s}\n", .{duped});
                }
            }
        }

        try responder.success(invocation.request.id, "{\"ok\":true}");
    }
};

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;

    var app_instance = App{
        .env_map = init.environ_map,
        .io = init.io,
        .codeql_bridge = bridge.CodeQlBridge.init(allocator, init.io),
        .dependabot_bridge = dependabot_bridge.DependabotBridge.init(allocator, init.io),
        .project_detector_bridge = project_detector_bridge.ProjectDetectorBridge.init(allocator, init.io),
        .copilot_bridge = copilot_bridge.CopilotBridge.init(allocator, init.io),
    };

    var system_bridge = SystemBridge.init(allocator, init.io);
    var settings_bridge = SettingsBridge{
        .codeql_bridge = &app_instance.codeql_bridge,
        .dependabot_bridge_instance = &app_instance.dependabot_bridge,
        .copilot_bridge_instance = &app_instance.copilot_bridge,
        .allocator = allocator,
    };

    const cq_disp = bridge.getDispatcher(allocator, &app_instance.codeql_bridge);
    
    var handlers = allocator.alloc(zero_native.bridge.AsyncHandler, cq_disp.async_registry.handlers.len + 6) catch @panic("OOM");
    var commands = allocator.alloc(zero_native.bridge.CommandPolicy, cq_disp.policy.commands.len + 6) catch @panic("OOM");

    @memcpy(handlers[0..cq_disp.async_registry.handlers.len], cq_disp.async_registry.handlers);
    handlers[cq_disp.async_registry.handlers.len] = .{
        .name = "dependabot.runScan",
        .context = &app_instance.dependabot_bridge,
        .invoke_fn = dependabot_bridge.DependabotBridge.runScan,
    };
    handlers[cq_disp.async_registry.handlers.len + 1] = .{
        .name = "scan.saveResults",
        .context = &system_bridge,
        .invoke_fn = SystemBridge.saveResults,
    };
    handlers[cq_disp.async_registry.handlers.len + 2] = .{
        .name = "project.detectStack",
        .context = &app_instance.project_detector_bridge,
        .invoke_fn = project_detector_bridge.ProjectDetectorBridge.detectStack,
    };
    handlers[cq_disp.async_registry.handlers.len + 3] = .{
        .name = "settings.updatePaths",
        .context = &settings_bridge,
        .invoke_fn = SettingsBridge.updatePaths,
    };
    handlers[cq_disp.async_registry.handlers.len + 4] = .{
        .name = "copilot.resolveIssues",
        .context = &app_instance.copilot_bridge,
        .invoke_fn = copilot_bridge.CopilotBridge.resolveIssues,
    };
    handlers[cq_disp.async_registry.handlers.len + 5] = .{
        .name = "copilot.login",
        .context = &app_instance.copilot_bridge,
        .invoke_fn = copilot_bridge.CopilotBridge.login,
    };
    @memcpy(commands[0..cq_disp.policy.commands.len], cq_disp.policy.commands);
    commands[cq_disp.policy.commands.len] = .{ .name = "dependabot.runScan", .origins = &.{"*"} };
    commands[cq_disp.policy.commands.len + 1] = .{ .name = "scan.saveResults", .origins = &.{"*"} };
    commands[cq_disp.policy.commands.len + 2] = .{ .name = "project.detectStack", .origins = &.{"*"} };
    commands[cq_disp.policy.commands.len + 3] = .{ .name = "settings.updatePaths", .origins = &.{"*"} };
    commands[cq_disp.policy.commands.len + 4] = .{ .name = "copilot.resolveIssues", .origins = &.{"*"} };
    commands[cq_disp.policy.commands.len + 5] = .{ .name = "copilot.login", .origins = &.{"*"} };

    const combined_dispatcher = zero_native.BridgeDispatcher{
        .policy = .{ .enabled = true, .commands = commands },
        .async_registry = .{ .handlers = handlers },
    };

    try runner.runWithOptions(app_instance.app(), .{
        .app_name = "ReportBot",
        .window_title = "ReportBot",
        .bundle_id = "dev.zero_native.my-app",
        .icon_path = "assets/icon.icns",
        .bridge = combined_dispatcher,
        .builtin_bridge = .{
            .enabled = true,
            .commands = &.{
                .{ .name = "zero-native.dialog.openFile", .origins = &.{"*"} },
            },
        },
        .security = .{
            .permissions = &.{ "filesystem" },
            .navigation = .{
                .allowed_origins = &.{"*"},
            },
        },
    }, init);

    // Free all resources to prevent memory leaks at shutdown
    allocator.free(cq_disp.async_registry.handlers);
    allocator.free(handlers);
    allocator.free(commands);

    if (app_instance.codeql_bridge.codeql_path.len > 0) {
        allocator.free(app_instance.codeql_bridge.codeql_path);
    }
    if (app_instance.codeql_bridge.dotnet_path.len > 0) {
        allocator.free(app_instance.codeql_bridge.dotnet_path);
    }
    if (app_instance.dependabot_bridge.dependabot_cli_path.len > 0) {
        allocator.free(app_instance.dependabot_bridge.dependabot_cli_path);
    }
    if (app_instance.copilot_bridge.copilot_cli_path.len > 0) {
        allocator.free(app_instance.copilot_bridge.copilot_cli_path);
    }
}
