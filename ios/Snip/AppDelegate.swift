import PlayerKit
import UIKit

/// iOS wakes the app when its background downloads finish; the completion handler is kept for the download session
/// to call once it has handled the events (DownloadStore).
final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping @Sendable () -> Void) {
    guard identifier == DownloadStore.sessionIdentifier else { return completionHandler() }
    DownloadStore.backgroundCompletion = completionHandler
  }
}
