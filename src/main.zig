const std = @import("std");
const runner = @import("runner");
const zero_native = @import("zero-native");
const bridge = @import("bridge.zig");

pub const panic = std.debug.FullPanic(zero_native.debug.capturePanic);

const App = struct {
    env_map: *std.process.Environ.Map,
    io: std.Io,
    codeql_bridge: bridge.CodeQlBridge,

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

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;

    var app_instance = App{
        .env_map = init.environ_map,
        .io = init.io,
        .codeql_bridge = bridge.CodeQlBridge.init(allocator, init.io),
    };

    try runner.runWithOptions(app_instance.app(), .{
        .app_name = "ReportBot",
        .window_title = "ReportBot",
        .bundle_id = "dev.zero_native.my-app",
        .icon_path = "assets/icon.icns",
        .bridge = bridge.getDispatcher(allocator, &app_instance.codeql_bridge),
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
}
