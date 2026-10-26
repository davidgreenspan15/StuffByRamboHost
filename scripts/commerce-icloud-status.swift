import Foundation

// This helper handles encrypted backup assets only. It never opens Keychain,
// credentials, customer data or the source archive outside the iCloud folder.
func run() throws {
    guard CommandLine.arguments.count == 3 else { throw CocoaError(.fileReadInvalidFileName) }
    let operation = CommandLine.arguments[1]
    let file = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL
    let root = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs/DatabaseBackups/GestureFlow", isDirectory: true)
        .standardizedFileURL
    guard ["status", "evict", "download"].contains(operation),
          file.path.hasPrefix(root.path + "/"),
          file.resolvingSymlinksInPath().path == file.path,
          (file.lastPathComponent.hasSuffix(".dump.age") || file.lastPathComponent == "manifest.json")
    else { throw CocoaError(.fileReadNoPermission) }
    if operation == "evict" {
        let values = try file.resourceValues(forKeys: [.ubiquitousItemIsUploadedKey, .ubiquitousItemHasUnresolvedConflictsKey])
        guard values.ubiquitousItemIsUploaded == true,
              values.ubiquitousItemHasUnresolvedConflicts != true else { throw CocoaError(.fileWriteUnknown) }
        try FileManager.default.evictUbiquitousItem(at: file)
    } else if operation == "download" {
        try FileManager.default.startDownloadingUbiquitousItem(at: file)
    }
    let values = try file.resourceValues(forKeys: [.isUbiquitousItemKey,
        .ubiquitousItemIsUploadedKey, .ubiquitousItemIsUploadingKey,
        .ubiquitousItemDownloadingStatusKey, .ubiquitousItemUploadingErrorKey,
        .ubiquitousItemHasUnresolvedConflictsKey])
    let result: [String: Any] = [
        "ubiquitous": values.isUbiquitousItem == true,
        "uploaded": values.ubiquitousItemIsUploaded == true,
        "uploading": values.ubiquitousItemIsUploading == true,
        "downloaded": values.ubiquitousItemDownloadingStatus == .current,
        "conflict": values.ubiquitousItemHasUnresolvedConflicts == true,
        "uploadError": values.ubiquitousItemUploadingError != nil,
    ]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}
do { try run() } catch {
    print("{\"error\":\"icloud_status_unavailable\"}")
    exit(2)
}
