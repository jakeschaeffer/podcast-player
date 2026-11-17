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

/// Two pages, one each side of the fold of a book-style foldable held open, split where the hinge runs (centred on the
/// screen rather than on the safe area, since the Duo's camera and status bar keep to one edge). Each page gets the
/// width from its screen edge's inset to the fold and pads its own edges, the fold side included: lists through their
/// row insets, other pages with their own margin.
///
/// Lying flat the screen is one sheet, so the pages meet at a hairline (`line`), or with no line where two grouped
/// lists' own cards already part them. Half open, the middle bends away from the reader, so the pages keep off a band
/// as wide as the bend, painted `gapFill` so two pages of one background still read as one sheet.
///
/// `split: false` gives the leading page the whole width and leaves the trailing one out, in the same place in the
/// view tree, so a list that is the leading page keeps its identity (and its scroll position) when the device folds
/// or turns.
struct HingeSplit<Leading: View, Trailing: View>: View {
  var split = true
  var gapFill: Color = .clear
  var line = true
  @ViewBuilder var leading: Leading
  @ViewBuilder var trailing: Trailing

  var body: some View {
    GeometryReader { geo in
      let fold = Fold.x(in: geo)
      let gap = Fold.isBent(in: geo, vertical: true) ? Fold.bend : 0
      HStack(spacing: 0) {
        leading.frame(width: split ? max(0, fold - gap / 2) : geo.size.width)
        if split {
          gapFill.frame(width: gap).ignoresSafeArea().accessibilityHidden(true)
          trailing.frame(width: max(0, geo.size.width - fold - gap / 2))
        }
      }
      .overlay(alignment: .leading) {
        if split, gap == 0, line {
          Rectangle().fill(Color(.separator)).frame(width: 1).offset(x: fold - 0.5)
            .ignoresSafeArea().accessibilityHidden(true)
        }
      }
    }
  }
}

/// The same split for the fold running across the screen: the iPhone Duo's inner display turned tall (669 × 951), where
/// the top half stands up and the bottom half lies flat when it is half open.
struct HingeStack<Top: View, Bottom: View>: View {
  var gap: CGFloat = 40
  @ViewBuilder var top: Top
  @ViewBuilder var bottom: Bottom

  var body: some View {
    GeometryReader { geo in
      let fold = Fold.y(in: geo)
      VStack(spacing: 0) {
        top.frame(width: geo.size.width, height: max(0, fold - gap / 2))
        Color.clear.frame(height: gap).accessibilityHidden(true)
        bottom.frame(width: geo.size.width, height: max(0, geo.size.height - fold - gap / 2))
      }
    }
  }
}

/// Where the fold runs, in a GeometryReader's own coordinates. iOS 27.1 reports it as a "division" reserved region (a
/// band about 40 pt across, there whether the hinge is flat or half folded); before that, and on a display without
/// one, it is taken to be the middle of the screen rather than of the safe area, since the insets at the two edges
/// differ (the Duo's status bar and camera keep to one side).
enum Fold {
  /// A fold down the middle (the inner display held wide): its x.
  static func x(in geo: GeometryProxy) -> CGFloat {
    if #available(iOS 27.1, *), let band = division(in: geo, vertical: true) { return band.midX }
    let insets = geo.safeAreaInsets
    return (geo.size.width + insets.leading + insets.trailing) / 2 - insets.leading
  }

  /// A fold across (the inner display turned tall): its y.
  static func y(in geo: GeometryProxy) -> CGFloat {
    if #available(iOS 27.1, *), let band = division(in: geo, vertical: false) { return band.midY }
    let insets = geo.safeAreaInsets
    return (geo.size.height + insets.top + insets.bottom) / 2 - insets.top
  }

  /// Half open with the fold across: the Duo standing like a small laptop, its top half upright and its bottom half
  /// flat on the table. iOS 27.1 marks the division region active only while the hinge is partly folded.
  static func isStanding(in geo: GeometryProxy) -> Bool {
    if #available(iOS 27.1, *) {
      return geo.reservedRegions(kind: .division).contains { $0.isActive && $0.frame.width > $0.frame.height }
    }
    return false
  }

  /// The width pages keep off where the screen bends, half open.
  static let bend: CGFloat = 40

  /// Half open (partly folded) rather than lying flat. iOS 27.1 marks the division region active only then.
  static func isBent(in geo: GeometryProxy, vertical: Bool) -> Bool {
    if #available(iOS 27.1, *) {
      return geo.reservedRegions(kind: .division).contains { $0.isActive && (vertical ? $0.frame.height > $0.frame.width : $0.frame.width > $0.frame.height) }
    }
    return false
  }

  @available(iOS 27.1, *)
  private static func division(in geo: GeometryProxy, vertical: Bool) -> CGRect? {
    geo.reservedRegions(kind: .division, options: .includeInactive)
      .map(\.frame)
      .first { vertical ? $0.height > $0.width : $0.width > $0.height }
  }
}

extension EnvironmentValues {
  /// The page is the right page beside a list (the iPhone Duo open and held wide), not one pushed on its own: the
  /// navigation bar's title is the list's, so the page leaves the bar's title alone.
  @Entry var besideList = false
}
