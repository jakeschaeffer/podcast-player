#if DEBUG
  import SnipActivity
  import SwiftUI

  /// The Live Activity's states at real size, drawn with its own views (SnipActivity's PlaybackActivityViews) on
  /// stand-ins for the lock screen and the Dynamic Island, for design checks: a script can't lock the simulator to see
  /// the real lock screen. `-activityGallery <page>` shows one page instead of the app: `lock` (playing, paused, the
  /// longest title), `ad` (ad breaks), `snip` and `snip2` (a snip's steps), `island` and `island2` (expanded), `compact`
  /// (compact and minimal), `paused` and `paused2` (every card while paused, on the lock screen and in the island). The stand-ins follow the system's frames: a 370 pt card at 76% black with 24 pt corners, a
  /// 370 pt island with 44 pt corners around the camera's 126 × 37 pt cutout, a 250 × 37 pt compact pill.
  struct ActivityGallery: View {
    let page: String

    var body: some View {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          switch page {
          case "ad":
            item("Ad break") { lock(.ad) }
            item("Ad break, longest title: the title steps aside") { lock(.adLongTitle) }
            item("Ad break, paused") { lock(.adPaused) }
            item("Ad break, a snip on its way: Snip shows a check") { lock(.adWhileSnipping) }
          case "snip":
            item("Just snipped") { lock(.snip(.choosing)) }
            item("No transcript yet") { lock(.snip(.waitingForTranscript)) }
            item("Moment chosen") { lock(.snip(.cutting)) }
            item("Clip ready") { lock(.snip(.naming)) }
            item("Named") { lock(.snip(.named)) }
          case "snip3":
            item("Moment chosen from the episode map: its passage title") { lock(.snip(.cutting, early: "How elevator operators learned the building's secrets")) }
            item("Clip ready, passage title") { lock(.snip(.naming, early: "How elevator operators learned the building's secrets")) }
            item("Clip ready, passage title, island") { expanded(.snip(.naming, early: "How elevator operators learned the building's secrets")) }
            item("Paused, passage title") { lock(.snip(.naming, playing: false, early: "How elevator operators learned the building's secrets")) }
          case "snip2":
            item("Named, the longest title the server writes") { lock(.snip(.named, title: Sample.longestSnipTitle)) }
            item("Failed") { lock(.snip(.failed)) }
            item("No connection: kept on the phone") { lock(.snip(.onPhone)) }
            item("No connection, island") { expanded(.snip(.onPhone)) }
          case "island":
            item("Playing") { expanded(.playing) }
            item("Paused") { expanded(.paused) }
            item("Ad break") { expanded(.ad) }
          case "island2":
            item("Just snipped") { expanded(.snip(.choosing)) }
            item("Named") { expanded(.snip(.named)) }
            item("Named, the longest title") { expanded(.snip(.named, title: Sample.longestSnipTitle)) }
          case "paused":
            item("Paused") { lock(.paused) }
            item("Paused, longest title") { lock(.longTitlePaused) }
            item("Paused in an ad break") { lock(.adPaused) }
            item("Paused, just snipped") { lock(.snip(.choosing, playing: false)) }
            item("Paused, named, the longest title") { lock(.snip(.named, title: Sample.longestSnipTitle, playing: false)) }
          case "paused2":
            item("Paused") { expanded(.paused) }
            item("Paused in an ad break") { expanded(.adPaused) }
            item("Paused, just snipped") { expanded(.snip(.choosing, playing: false)) }
            item("Paused, named, the longest title") { expanded(.snip(.named, title: Sample.longestSnipTitle, playing: false)) }
            item("Compact: paused, paused in an ad break") {
              VStack(spacing: 10) { compact(.paused); compact(.adPaused) }
            }
          case "compact":
            item("Compact: playing, paused, ad break") {
              VStack(spacing: 10) { compact(.playing); compact(.paused); compact(.ad) }
            }
            item("Compact: snipping, named, failed") {
              VStack(spacing: 10) { compact(.snip(.cutting)); compact(.snip(.named)); compact(.snip(.failed)) }
            }
            item("Minimal: playing, ad break, named") {
              HStack(spacing: 16) { minimal(.playing); minimal(.ad); minimal(.snip(.named)) }
            }
          default:
            item("Playing") { lock(.playing) }
            item("Playing at 1.5×: the position as of the last update") { lock(.fast) }
            item("Playing, longest title") { lock(.longTitle) }
            item("Paused") { lock(.paused) }
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 64)
        .frame(maxWidth: .infinity)
      }
      .scrollIndicators(.hidden)
      .background(Self.wallpaper.ignoresSafeArea())
      .environment(\.colorScheme, .dark)
    }

    private func item<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
      VStack(alignment: .leading, spacing: 6) {
        Text(label).font(.footnote).foregroundStyle(.white.opacity(0.7))
        content()
      }
    }

    private func lock(_ state: PlaybackState) -> some View {
      PlaybackLockScreenView(state: state)
        .frame(width: 370)
        .background(ActivityPalette.plate, in: .rect(cornerRadius: 24, style: .continuous))
    }

    private func expanded(_ state: PlaybackState) -> some View {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 0) {
          PlaybackIslandLeading(state: state).frame(width: 98, alignment: .leading)
          Capsule().fill(Color(white: 0.05)).frame(width: 126, height: 37)
          PlaybackIslandTrailing(state: state).frame(width: 98, alignment: .trailing)
        }
        .frame(height: 37)
        PlaybackIslandBottom(state: state)
      }
      .padding(EdgeInsets(top: 11, leading: 24, bottom: 18, trailing: 22))
      .frame(width: 370)
      .background(.black, in: .rect(cornerRadius: 44, style: .continuous))
    }

    private func compact(_ state: PlaybackState) -> some View {
      HStack(spacing: 0) {
        PlaybackCompactLeading(state: state)
        Spacer(minLength: 0)
        PlaybackCompactTrailing(state: state)
      }
      .padding(.leading, 14)
      .padding(.trailing, 13)
      .frame(width: 250, height: 37)
      .background(.black, in: .capsule)
      .overlay { Capsule().stroke(Color(white: 0.16), lineWidth: 1).frame(width: 126, height: 37) }
    }

    private func minimal(_ state: PlaybackState) -> some View {
      PlaybackMinimal(state: state).frame(width: 37, height: 37).background(.black, in: .circle)
    }

    private static let wallpaper = LinearGradient(
      colors: [Color(red: 0.18, green: 0.19, blue: 0.40), Color(red: 0.32, green: 0.21, blue: 0.42), Color(red: 0.48, green: 0.27, blue: 0.40)],
      startPoint: .topLeading, endPoint: .bottomTrailing)
  }

  /// The mockup's sample content, so the gallery compares with it.
  private enum Sample {
    static let longestSnipTitle = "Why elevator operators knew every secret in the old building"
  }

  extension PlaybackState {
    fileprivate static func episode(
      _ show: String, _ title: String, at positionMs: Int, of durationMs: Int, playing: Bool = true, speed: Double = 1,
      ad: ClosedRange<Int>? = nil, snip: SnipProgress? = nil
    ) -> PlaybackState {
      PlaybackState(
        episodeID: "sample", showTitle: show, title: title, playing: playing, positionMs: positionMs,
        durationMs: durationMs, speed: speed, adBreakStartMs: ad?.lowerBound, adBreakEndMs: ad?.upperBound, snip: snip)
    }

    fileprivate static let longTitle = episode(
      "The Daily", "The Sunday Read: ‘The Unraveling of a Small-Town Bakery Empire, Told by the People Who Built It’",
      at: 1_083_000, of: 2_851_000)
    fileprivate static let longTitlePaused = episode(
      "The Daily", "The Sunday Read: ‘The Unraveling of a Small-Town Bakery Empire, Told by the People Who Built It’",
      at: 5_534_000, of: 7_928_000, playing: false)
    fileprivate static let playing = episode("Acquired", "Costco (with Craig Jelinek)", at: 1_934_000, of: 4_328_000)
    fileprivate static let fast = episode("Acquired", "Costco (with Craig Jelinek)", at: 1_934_000, of: 4_328_000, speed: 1.5)
    fileprivate static let paused = episode("Acquired", "Costco (with Craig Jelinek)", at: 1_934_000, of: 4_328_000, playing: false)
    fileprivate static let ad = episode("Hard Fork", "The A.I. Phone Is Here", at: 760_000, of: 3_482_000, ad: 712_000...808_000)
    fileprivate static let adLongTitle = episode(
      "The Daily", "The Sunday Read: ‘The Unraveling of a Small-Town Bakery Empire, Told by the People Who Built It’",
      at: 1_120_000, of: 2_851_000, ad: 1_057_000...1_147_000)
    fileprivate static let adPaused = episode(
      "Hard Fork", "The A.I. Phone Is Here", at: 760_000, of: 3_482_000, playing: false, ad: 712_000...808_000)
    fileprivate static let adWhileSnipping = episode(
      "Hard Fork", "The A.I. Phone Is Here", at: 760_000, of: 3_482_000, ad: 712_000...808_000,
      snip: SnipProgress(step: .cutting, snipID: "sample", anchorMs: 744_000))

    /// `early`: the passage title an episode map gives before the snip's own is written.
    fileprivate static func snip(_ step: SnipProgress.Step, title: String = "Elevator operators knew everyone’s secrets", playing: Bool = true, early: String? = nil) -> PlaybackState {
      let progress = SnipProgress(
        step: step, snipID: "sample", anchorMs: 439_000, lengthMs: step == .named ? 42_000 : nil,
        title: step == .named ? title : early, error: step == .failed ? "render failed: ffmpeg exited with code 1" : nil)
      return episode("99% Invisible", "The Lost Art of the Elevator Operator", at: 441_000, of: 2_712_000, playing: playing, snip: progress)
    }
  }
#endif
