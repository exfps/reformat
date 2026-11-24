import Foundation
import AVFoundation
import CoreGraphics
import CoreVideo

let width = 320
let height = 180
let fps = 24
let seconds = 2
let output = CommandLine.arguments.dropFirst().first ?? "sample.mp4"
let url = URL(fileURLWithPath: output)
try? FileManager.default.removeItem(at: url)
guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else {
    fatalError("Couldn't create the video writer")
}
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 260_000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264BaselineAutoLevel
    ]
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let attributes: [String: Any] = [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
    kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
]
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attributes)
guard writer.canAdd(input) else { fatalError("Can't add the video input") }
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)
let colorSpace = CGColorSpaceCreateDeviceRGB()
for frame in 0..<(fps * seconds) {
    var buffer: CVPixelBuffer?
    guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32ARGB, attributes as CFDictionary, &buffer) == kCVReturnSuccess,
          let buffer else { fatalError("Couldn't create a frame") }
    CVPixelBufferLockBaseAddress(buffer, [])
    if let base = CVPixelBufferGetBaseAddress(buffer),
       let context = CGContext(data: base, width: width, height: height, bitsPerComponent: 8,
                               bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: colorSpace,
                               bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) {
        let progress = CGFloat(frame) / CGFloat(fps * seconds)
        context.setFillColor(CGColor(red: 0.10, green: 0.16, blue: 0.12, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(red: 0.82, green: 0.93, blue: 0.44, alpha: 1))
        let x = 36 + (CGFloat(width) - 92) * progress
        context.fillEllipse(in: CGRect(x: x, y: 54, width: 56, height: 56))
        context.setFillColor(CGColor(red: 0.91, green: 0.53, blue: 0.38, alpha: 1))
        context.fill(CGRect(x: 22, y: 142, width: 276, height: 4))
        context.setFillColor(CGColor(red: 1, green: 0.97, blue: 0.89, alpha: 0.85))
        context.fill(CGRect(x: 22, y: 22, width: 104, height: 6))
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    let time = CMTime(value: Int64(frame), timescale: Int32(fps))
    while !input.isReadyForMoreMediaData { usleep(2_000) }
    guard adaptor.append(buffer, withPresentationTime: time) else { fatalError("Couldn't append a frame") }
}
input.markAsFinished()
let semaphore = DispatchSemaphore(value: 0)
writer.finishWriting { semaphore.signal() }
semaphore.wait()
print(output)
