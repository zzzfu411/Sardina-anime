// Package the original #097 logo, mirrored horizontally as requested, as a macOS icon.
// swift -module-cache-path .cache/swift scripts/create-icon.swift
import AppKit
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = root.appendingPathComponent("assets/sardina-anime-logo.png")
guard let logo = NSImage(contentsOf: source) else { fatalError("Generated logo is missing") }
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSGraphicsContext.current?.imageInterpolation = .high
NSColor(red: 0.847, green: 0.827, blue: 0.8, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 56, y: 56, width: 912, height: 912), xRadius: 196, yRadius: 196).fill()
NSGraphicsContext.saveGraphicsState()
let mirror = NSAffineTransform()
mirror.translateX(by: 1024, yBy: 0)
mirror.scaleX(by: -1, yBy: 1)
mirror.concat()
logo.draw(in: NSRect(x: 42, y: 198, width: 940, height: 940 * logo.size.height / logo.size.width))
NSGraphicsContext.restoreGraphicsState()
NSGraphicsContext.restoreGraphicsState()
let png = root.appendingPathComponent("assets/icon.png")
try bitmap.representation(using: .png, properties: [:])!.write(to: png)
let iconset = root.appendingPathComponent(".cache/sardina-anime.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
func run(_ binary: String, _ arguments: [String]) throws {
    let process = Process(); process.executableURL = URL(fileURLWithPath: binary); process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    try process.run(); process.waitUntilExit()
    guard process.terminationStatus == 0 else { fatalError("Icon packaging failed") }
}
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        let target = iconset.appendingPathComponent("icon_\(size)x\(size)\(suffix).png")
        try run("/usr/bin/sips", ["-z", String(size * scale), String(size * scale), png.path, "--out", target.path])
    }
}
try run("/usr/bin/iconutil", ["-c", "icns", iconset.path, "-o", root.appendingPathComponent("assets/icon.icns").path])
print("Sardina anime icons generated")
