import CoreGraphics
import Foundation

let pids = Set(CommandLine.arguments.dropFirst().compactMap { Int($0) })
let all = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
let mine = all.filter { pids.contains($0[kCGWindowOwnerPID as String] as? Int ?? -1) && ($0[kCGWindowLayer as String] as? Int) == 0 }
let onscreen = mine.filter { ($0[kCGWindowIsOnscreen as String] as? Bool) == true }
print("{\"windows\":\(mine.count),\"onscreen\":\(onscreen.count)}")
