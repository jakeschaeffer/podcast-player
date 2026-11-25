import SwiftUI

extension View {
  /// Kept in the layout but unseen and untouchable while `available` is false: a control for something this phone
  /// can't do without a server (AppModel.hasServer). Its place stays, so the controls beside it don't move.
  func available(_ available: Bool) -> some View {
    opacity(available ? 1 : 0).allowsHitTesting(available).accessibilityHidden(!available)
  }
}
