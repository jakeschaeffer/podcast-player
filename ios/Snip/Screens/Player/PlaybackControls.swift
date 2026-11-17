import PlayerKit
import SwiftUI

/// The seek bar with the elapsed and remaining time under it, made to feel like the system players': a finger anywhere
/// on the bar takes hold (not only on the thumb, which a quick drag used to miss), the thumb follows the finger's
/// movement from where it was rather than jumping under it, the bar thickens while held, and the seek happens when the
/// finger lifts. A drag the system takes over (a sheet, an edge swipe) ends the same way, with a seek to where the thumb
/// was. `onInteraction` is told of any touch, for a screen that hides its controls by itself.
struct Scrubber: View {
  @Environment(PlayerEngine.self) private var engine
  var onInteraction: () -> Void = {}
  /// Laid over a video: the times in white with a shadow, so they read on a bright frame.
  var onVideo = false
  /// The times in large type (the iPhone Duo standing half open, where the controls fill a half of the screen).
  var large = false
  /// Where the thumb is while a finger holds the bar; nil when the bar follows the playhead.
  @State private var scrubbing: Double?
  /// The position when the finger came down: the drag moves the thumb from here.
  @State private var dragFrom: Double?
  /// A finger is on the bar. It resets by itself when the drag ends or is cancelled, which is how a drag the system
  /// took over still seeks.
  @GestureState private var held = false

  var body: some View {
    let duration = Double(max(engine.durationMs, 1))
    let shown = min(max(scrubbing ?? Double(engine.positionMs), 0), duration)
    VStack(spacing: 2) {
      bar(fraction: shown / duration, duration: duration)
      HStack {
        Text(Format.clock(Int(shown)))
        Spacer()
        Text("-" + Format.clock(engine.durationMs - Int(shown)))
      }
      .font((large ? Font.title3.weight(.semibold) : .caption).monospacedDigit())
      .foregroundStyle(onVideo ? AnyShapeStyle(.white.opacity(0.9)) : AnyShapeStyle(.secondary))
      .shadow(color: .black.opacity(onVideo ? 0.7 : 0), radius: 3)
    }
    .onChange(of: held) { _, now in if !now { commit() } }
    .onDisappear { commit() }
  }

  private func bar(fraction: Double, duration: Double) -> some View {
    let active = held
    let track: CGFloat = active ? 12 : 6
    let thumb: CGFloat = active ? 30 : 22
    return GeometryReader { geo in
      let width = max(geo.size.width, 1)
      ZStack(alignment: .leading) {
        Capsule().fill(onVideo ? AnyShapeStyle(.white.opacity(0.35)) : AnyShapeStyle(.quaternary))
          .frame(height: track)
        Capsule().fill(onVideo ? AnyShapeStyle(.white) : AnyShapeStyle(.tint))
          .frame(width: max(track, width * fraction), height: track)
        Circle().fill(onVideo ? AnyShapeStyle(.white) : AnyShapeStyle(.tint))
          .frame(width: thumb, height: thumb)
          .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
          .offset(x: min(max(width * fraction - thumb / 2, 0), width - thumb))
      }
      .frame(width: width, height: geo.size.height)
      .contentShape(Rectangle())
      .highPriorityGesture(
        DragGesture(minimumDistance: 0)
          .updating($held) { _, state, _ in state = true }
          .onChanged { drag in
            onInteraction()
            let from = dragFrom ?? scrubbing ?? Double(engine.positionMs)
            if dragFrom == nil { dragFrom = from }
            scrubbing = min(max(from + Double(drag.translation.width / width) * duration, 0), duration)
          }
          .onEnded { _ in commit() }
      )
      .animation(.easeOut(duration: 0.15), value: active)
    }
    .frame(height: 44)
    .accessibilityRepresentation {
      Slider(value: Binding(get: { Double(engine.positionMs) }, set: { engine.seek(to: Int($0)) }), in: 0...duration) {
        Text("Position")
      }
    }
  }

  private func commit() {
    let from = dragFrom
    dragFrom = nil
    guard let to = scrubbing else { return }
    scrubbing = nil
    // A touch that didn't move the thumb is not a seek: a seek to the same spot would stutter the audio.
    if let from, abs(to - from) < 250 { return }
    engine.seek(to: Int(to))
  }
}

/// Speed, skip back 15, play or pause, skip forward 30, Snip: the player's controls, the same wherever the player is
/// shown. Snip is the app's main action, so it is the accent button. During a suspected ad break, Skip ad stands in the
/// speed button's place, in its slot's width so the other controls never move; Snip has a slot of the same width at
/// the other end, so the row is symmetric and play sits in the middle of it. `onInteraction` is told of every press.
struct TransportRow: View {
  @Environment(AppModel.self) private var model
  @Environment(PlayerEngine.self) private var engine
  var onInteraction: () -> Void = {}
  /// Laid over a video: a shadow under the buttons, so they read on a bright frame.
  var onVideo = false
  /// Every control half as large again (the iPhone Duo standing half open, where the row has a half of the screen).
  var large = false

  /// The app icon's dark, for marks on the accent colour.
  static let ink = Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x11 / 255)

  var body: some View {
    HStack {
      // One slot for speed and the ad buttons (Skip ad, Undo skip), as wide as the widest of them (kept in the
      // layout unseen), so neither spills onto the button beside it and nothing moves when they come and go.
      let offer = AdOffer.of(engine)
      ZStack(alignment: .leading) {
        adSlot
        Button { press { engine.cycleSpeed() } } label: {
          Text(engine.speed.formatted(.number.precision(.fractionLength(0...2))) + "×")
            .font((large ? Font.title2.weight(.bold) : .callout.weight(.semibold)).monospacedDigit())
            .frame(minWidth: large ? 64 : 44, minHeight: large ? 64 : 44)
        }
        .opacity(offer == nil ? 1 : 0)
        .allowsHitTesting(offer == nil)
        if let offer {
          Button { press { offer.act(on: engine) } } label: { adButton(offer) }
            .transition(.opacity)
            .id(offer)
        }
      }
      .animation(.easeInOut(duration: 0.25), value: offer)
      Spacer(minLength: 0)
      Button { press { engine.skip(by: -15_000) } } label: { Image(systemName: "gobackward.15").font(large ? .system(size: 40) : .title2).frame(minWidth: large ? 64 : nil, minHeight: large ? 64 : nil) }
      Spacer(minLength: 0)
      Button { press { engine.toggle() } } label: {
        Image(systemName: engine.playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: large ? 100 : 64))
          .overlay {
            // Waiting for audio: say so instead of showing a pause button over silence.
            if engine.playing && engine.buffering { ProgressView().controlSize(.large).tint(.white) }
          }
      }
      Spacer(minLength: 0)
      Button { press { engine.skip(by: 30_000) } } label: { Image(systemName: "goforward.30").font(large ? .system(size: 40) : .title2).frame(minWidth: large ? 64 : nil, minHeight: large ? 64 : nil) }
      Spacer(minLength: 0)
      // The same slot at this end, with Snip at its edge: with the ends equal, the spacers put play in the middle.
      ZStack(alignment: .trailing) {
        adSlot
        Button {
          press { Task { await model.snip() } }
        } label: {
          Image(systemName: "scissors")
            .font((large ? Font.title : .title3).weight(.semibold))
            .foregroundStyle(Self.ink)
            .frame(width: large ? 80 : 48, height: large ? 80 : 48)
            .background(Color.accentColor, in: .circle)
        }
        .accessibilityLabel("Snip")
        .sensoryFeedback(.impact, trigger: model.snipCard.map(ObjectIdentifier.init))
      }
    }
    .buttonStyle(.plain)
    .shadow(color: .black.opacity(onVideo ? 0.6 : 0), radius: 6)
    // Five controls share one row; past the largest ordinary text size they would no longer fit it.
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
  }

  /// Every ad button laid over one another, unseen: what sizes a slot.
  private var adSlot: some View {
    ZStack {
      adButton(.skip)
      adButton(.undo)
    }
    .hidden()
  }

  private func adButton(_ offer: AdOffer) -> some View {
    Text(offer.title)
      .font(.footnote.weight(.bold))
      .foregroundStyle(onVideo ? Color.white : Color.primary)
      .padding(.horizontal, 10)
      .frame(height: 34)
      .overlay { Capsule().stroke(Color.accentColor, lineWidth: 1.5) }
      .contentShape(.capsule)
      .fixedSize()
  }

  private func press(_ action: () -> Void) {
    onInteraction()
    action()
  }
}
