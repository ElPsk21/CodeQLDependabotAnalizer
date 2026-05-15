const std = @import("std");
pub fn main() !void {
    @compileLog(@typeInfo(std.heap).Struct.decls);
}

