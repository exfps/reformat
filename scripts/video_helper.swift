import Foundation
import AVFoundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct ProbeResult: Codable {
    let duration: Double
    let width: Int
    let height: Int
    let thumbnail: String
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func number(_ value: String?) -> Double? {
    guard let value else { return nil }
    return Double(value)
}

var options: [String: String] = [:]
var index = 1
let arguments = CommandLine.arguments
while index < arguments.count {
    let key = arguments[index]
    guard key.hasPrefix("--"), index + 1 < arguments.count else {
        fail("Invalid arguments")
    }
    options[key] = arguments[index + 1]
    index += 2
}

let mode = options["--mode"] ?? "probe"
guard let input = options["--input"] else { fail("No input video was provided.") }
let inputURL = URL(fileURLWithPath: input)
guard FileManager.default.fileExists(atPath: inputURL.path) else { fail("The video file could not be found.") }

let asset = AVURLAsset(url: inputURL, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
let assetDuration = CMTimeGetSeconds(asset.duration)
guard assetDuration.isFinite, assetDuration > 0 else { fail("This video has no readable duration.") }
let tracks = asset.tracks(withMediaType: .video)
guard let track = tracks.first else { fail("This file doesn't contain a video track.") }
let transformed = track.naturalSize.applying(track.preferredTransform)
let videoWidth = max(1, Int(abs(transformed.width).rounded()))
let videoHeight = max(1, Int(abs(transformed.height).rounded()))

let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero

if mode == "probe" {
    guard let thumbnailPath = options["--thumbnail"] else { fail("No thumbnail destination was provided.") }
    generator.maximumSize = CGSize(width: 720, height: 720)
    let probeTime = CMTime(seconds: min(max(assetDuration * 0.18, 0.05), assetDuration - 0.05), preferredTimescale: 600)
    guard let image = try? generator.copyCGImage(at: probeTime, actualTime: nil) else {
        fail("The video preview couldn't be generated.")
    }
    let thumbnailURL = URL(fileURLWithPath: thumbnailPath) as CFURL
    guard let destination = CGImageDestinationCreateWithURL(thumbnailURL, UTType.jpeg.identifier as CFString, 1, nil) else {
        fail("Couldn't prepare the video preview.")
    }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { fail("Couldn't save the video preview.") }
    let result = ProbeResult(duration: assetDuration, width: videoWidth, height: videoHeight, thumbnail: thumbnailPath)
    let data = try JSONEncoder().encode(result)
    print(String(data: data, encoding: .utf8)!)
    exit(0)
}

guard mode == "gif" else { fail("Unknown video helper mode.") }
guard let output = options["--output"] else { fail("No GIF destination was provided.") }
let start = max(0, min(number(options["--start"]) ?? 0, assetDuration - 0.05))
let requestedDuration = number(options["--duration"]) ?? min(assetDuration - start, 6)
let duration = min(max(requestedDuration, 0.15), assetDuration - start)
let fps = min(max(number(options["--fps"]) ?? 12, 4), 20)
let width = min(max(Int(options["--width"] ?? "640") ?? 640, 160), 1280)
let loops = (options["--loop"] ?? "true") != "false"
let frameCount = min(300, max(1, Int((duration * fps).rounded())))
generator.maximumSize = CGSize(width: width, height: width * 4)

let outputURL = URL(fileURLWithPath: output)
try? FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
try? FileManager.default.removeItem(at: outputURL)
guard let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, UTType.gif.identifier as CFString, frameCount, nil) else {
    fail("Couldn't prepare the GIF file.")
}
let gifProperties: [CFString: Any] = [
    kCGImagePropertyGIFDictionary: [
        kCGImagePropertyGIFLoopCount: loops ? 0 : 1
    ]
]
CGImageDestinationSetProperties(destination, gifProperties as CFDictionary)
let frameDuration = 1.0 / fps
for frame in 0..<frameCount {
    let time = min(start + Double(frame) / fps, assetDuration - 0.01)
    let cmTime = CMTime(seconds: time, preferredTimescale: 600)
    guard let image = try? generator.copyCGImage(at: cmTime, actualTime: nil) else {
        fail("A frame at \(String(format: "%.2f", time))s could not be read.")
    }
    let frameProperties: [CFString: Any] = [
        kCGImagePropertyGIFDictionary: [
            kCGImagePropertyGIFDelayTime: frameDuration
        ]
    ]
    CGImageDestinationAddImage(destination, image, frameProperties as CFDictionary)
    print("PROGRESS \(frame + 1)/\(frameCount)")
    fflush(stdout)
}
guard CGImageDestinationFinalize(destination) else { fail("The GIF could not be finalized.") }
print("DONE")
