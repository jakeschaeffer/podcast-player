import SwiftUI
import UIKit

/// The share sheet's "Snip" (ios/README.md, "Share sheet"): a link shared from Safari, the YouTube app or anywhere
/// else goes to the server the app is signed in to. The extension runs in its own process with none of the app's
/// state; `SharedSession` (PodcastAPI) gives it the server and the token through the shared Keychain group. The
/// view does the work and says what was made, or why not.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
    let host = UIHostingController(rootView: ShareView(items: items) { [weak self] in
      self?.extensionContext?.completeRequest(returningItems: nil)
    })
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
  }
}
