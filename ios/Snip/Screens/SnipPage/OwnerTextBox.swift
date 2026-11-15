import SwiftUI
import UIKit

/// The box the owner types a snip's title, summary or note in, on UIKit's text view, so it behaves the same with the
/// on-screen keyboard and a hardware one: Return starts a new line in the summary and the note and saves the title
/// (a SwiftUI vertical TextField ends editing on a hardware Return instead, and what is typed after it goes nowhere).
/// It grows with its text, takes the keyboard when it is made (a field just opened, or the page laid out again after
/// the device was turned, folded or opened) and whenever `focusRequest` changes, and remembers where the cursor was
/// (`selection`), so a box made again carries on where the owner left off. A title selects all of itself the first time
/// it takes the keyboard in an edit (typing replaces it); after that a tap only places the cursor.
struct OwnerTextBox: UIViewRepresentable {
  enum Face { case title, compactTitle, text, compactText, body }

  @Binding var text: String
  /// Where the cursor or selection was, in UTF-16 offsets; nil until the box first had the keyboard in this edit.
  @Binding var selection: NSRange?
  let face: Face
  /// One line: Return calls `onReturn` instead of starting a new line, and pasted line breaks become spaces.
  let singleLine: Bool
  /// While saving, typing is held (the text stays as it is) without taking the keyboard away.
  let locked: Bool
  var focusRequest = 0
  /// Takes the keyboard as soon as it is made (a field just opened); a box among others, in a form, waits for a tap.
  var takesFocus = true
  let accessibilityLabel: String
  /// Return in a one-line box; without it, Return just puts the keyboard away.
  var onReturn: (() -> Void)?

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> BoxTextView {
    let view = BoxTextView()
    view.delegate = context.coordinator
    view.backgroundColor = .clear
    view.isScrollEnabled = false
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.adjustsFontForContentSizeCategory = false
    view.autocapitalizationType = .sentences
    view.returnKeyType = singleLine ? .done : .default
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    view.setContentHuggingPriority(.defaultLow, for: .horizontal)
    view.text = text
    view.accessibilityLabel = accessibilityLabel
    context.coordinator.lastFocusRequest = focusRequest
    if takesFocus { view.onWindow = { [weak coordinator = context.coordinator] view in coordinator?.focus(view) } }
    return view
  }

  func updateUIView(_ view: BoxTextView, context: Context) {
    let coordinator = context.coordinator
    coordinator.parent = self
    let font = Self.font(face, size: context.environment.dynamicTypeSize)
    if view.font != font { view.font = font }
    view.textColor = .label
    if view.text != text {
      let kept = view.selectedRange
      view.text = text
      let length = (text as NSString).length
      view.selectedRange = NSRange(location: min(kept.location, length), length: 0)
    }
    if focusRequest != coordinator.lastFocusRequest {
      coordinator.lastFocusRequest = focusRequest
      coordinator.focus(view)
    }
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: BoxTextView, context: Context) -> CGSize? {
    guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
    let fit = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    return CGSize(width: width, height: ceil(fit.height))
  }

  /// The SwiftUI faces the page shows these texts in (`SnipPage.titleFont` and the rest), at the page's type size.
  static func font(_ face: Face, size: DynamicTypeSize) -> UIFont {
    let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size))
    let (style, bold, rounded): (UIFont.TextStyle, Bool, Bool) =
      switch face {
      case .title: (.largeTitle, true, true)
      case .compactTitle: (.title1, true, true)
      case .text: (.title2, false, false)
      case .compactText: (.title3, false, false)
      case .body: (.body, false, false)
      }
    var descriptor = UIFontDescriptor.preferredFontDescriptor(withTextStyle: style, compatibleWith: traits)
    if rounded, let roundedDescriptor = descriptor.withDesign(.rounded) { descriptor = roundedDescriptor }
    if bold, let boldDescriptor = descriptor.withSymbolicTraits(.traitBold) { descriptor = boldDescriptor }
    return UIFont(descriptor: descriptor, size: 0)
  }

  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: OwnerTextBox
    var lastFocusRequest = 0
    /// The keyboard was asked for by the box itself rather than by a tap, so the cursor goes back where it was.
    private var focusing = false
    /// Where the cursor was, for a box whose `selection` is not kept anywhere (a constant binding).
    private var known: NSRange?

    init(_ parent: OwnerTextBox) { self.parent = parent }

    func focus(_ view: UITextView) {
      guard view.window != nil, !view.isFirstResponder else { return }
      focusing = true
      view.becomeFirstResponder()
      focusing = false
    }

    func textViewDidBeginEditing(_ view: UITextView) {
      let length = (view.text as NSString).length
      if let kept = parent.selection ?? known {
        // A tap places the cursor where it lands; the box taking the keyboard itself puts it back where it was.
        guard focusing else { return }
        let location = min(kept.location, length)
        let restored = NSRange(location: location, length: min(kept.length, length - location))
        DispatchQueue.main.async { view.selectedRange = restored }
      } else {
        // The first time in this edit: the whole title, to type over; the end of a summary or note, to add to it.
        let first = parent.singleLine ? NSRange(location: 0, length: length) : NSRange(location: length, length: 0)
        parent.selection = first
        known = first
        // A box opened by a tap among others (`takesFocus` off) keeps the cursor where the tap put it, but the title.
        guard parent.takesFocus || parent.singleLine else { return }
        DispatchQueue.main.async { view.selectedRange = first }
      }
    }

    func textViewDidChangeSelection(_ view: UITextView) {
      guard view.isFirstResponder else { return }
      parent.selection = view.selectedRange
      known = view.selectedRange
    }

    func textViewDidChange(_ view: UITextView) {
      parent.text = view.text
    }

    func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
      guard !parent.locked else { return false }
      guard parent.singleLine, text.contains(where: \.isNewline) else { return true }
      if text == "\n" {
        if let onReturn = parent.onReturn { onReturn() } else { view.resignFirstResponder() }
        return false
      }
      // Pasted lines run on as one.
      let joined = text.split(whereSeparator: \.isNewline).joined(separator: " ")
      if let start = view.position(from: view.beginningOfDocument, offset: range.location),
        let end = view.position(from: start, offset: range.length),
        let textRange = view.textRange(from: start, to: end)
      {
        view.replace(textRange, withText: joined)
      }
      return false
    }
  }

  /// The text view, telling the box when it is in a window and so can take the keyboard.
  final class BoxTextView: UITextView {
    var onWindow: ((UITextView) -> Void)?

    override func didMoveToWindow() {
      super.didMoveToWindow()
      guard window != nil else { return }
      // Once the page around it has been laid out.
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.onWindow?(self)
      }
    }
  }
}
