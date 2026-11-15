import SwiftUI
import UIKit

/// The iPhone Duo open: its inner display is a phone that is regular in both size classes, held wide (951 × 669 pt,
/// the fold running down the middle) or turned tall (669 × 951). Closed, the outer display is an ordinary compact
/// phone, and a phone on its side is compact in height, so neither counts.
enum UnfoldedDisplay {
  static func isUnfolded(horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?) -> Bool {
    UIDevice.current.userInterfaceIdiom == .phone && horizontal == .regular && vertical == .regular
  }

  /// Held wide: two pages, one each side of the fold, as the web app's wide layout splits the player and editor.
  static func isSpread(horizontal: UserInterfaceSizeClass?, vertical: UserInterfaceSizeClass?, size: CGSize) -> Bool {
    isUnfolded(horizontal: horizontal, vertical: vertical) && size.width > size.height
  }
}

extension View {
  /// One text size up on the unfolded display, which is held further away than a phone: the whole app reads larger
  /// there instead of fitting more in. It steps from the system's setting, so applying it again (a full-screen
  /// presentation has to) never compounds, and the reader's own text size still governs.
  func unfoldedTypeScale() -> some View { modifier(UnfoldedTypeScale()) }

  /// Holds a list to a readable width on the unfolded display held wide, centred, as the web app's wide layout does
  /// (720 px). Elsewhere it changes nothing.
  func unfoldedReadableWidth() -> some View { modifier(UnfoldedReadableWidth()) }
}

private struct UnfoldedTypeScale: ViewModifier {
  @Environment(\.horizontalSizeClass) private var horizontal
  @Environment(\.verticalSizeClass) private var vertical
  @Environment(\.dynamicTypeSize) private var inherited

  func body(content: Content) -> some View {
    content.environment(\.dynamicTypeSize, size)
  }

  private var size: DynamicTypeSize {
    guard UnfoldedDisplay.isUnfolded(horizontal: horizontal, vertical: vertical) else { return inherited }
    // `inherited` is read so a change to the system setting draws again; the step is from the system's own size.
    let system = DynamicTypeSize(UIApplication.shared.preferredContentSizeCategory) ?? inherited
    let sizes = DynamicTypeSize.allCases
    guard let index = sizes.firstIndex(of: system) else { return system }
    return sizes[min(index + 1, sizes.count - 1)]
  }
}

private struct UnfoldedReadableWidth: ViewModifier {
  static let readable: CGFloat = 720
  @Environment(\.horizontalSizeClass) private var horizontal
  @Environment(\.verticalSizeClass) private var vertical
  @State private var size = CGSize.zero

  func body(content: Content) -> some View {
    content
      .safeAreaPadding(.horizontal, margin)
      .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
  }

  private var margin: CGFloat {
    guard UnfoldedDisplay.isSpread(horizontal: horizontal, vertical: vertical, size: size) else { return 0 }
    return max(0, (size.width - Self.readable) / 2)
  }
}

/// Two pages, one each side of the fold of a book-style foldable held open: the gap between them is centred on the
/// screen rather than on the safe area, so the hinge falls in it even where the insets at the two edges differ (the
/// Duo's camera and status bar keep to one side). Each page gets the width from its screen edge's inset to the gap;
/// the pages pad their own outer edges.
struct HingeSplit<Leading: View, Trailing: View>: View {
  var gap: CGFloat = 48
  @ViewBuilder var leading: Leading
  @ViewBuilder var trailing: Trailing

  var body: some View {
    GeometryReader { geo in
      let insets = geo.safeAreaInsets
      let screen = geo.size.width + insets.leading + insets.trailing
      // The fold, in this view's coordinates, which begin at the leading inset.
      let fold = screen / 2 - insets.leading
      HStack(spacing: 0) {
        leading.frame(width: max(0, fold - gap / 2))
        Color.clear.frame(width: gap).accessibilityHidden(true)
        trailing.frame(width: max(0, geo.size.width - fold - gap / 2))
      }
    }
  }
}
