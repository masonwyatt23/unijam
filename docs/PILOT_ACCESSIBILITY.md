# Pilot accessibility verification

Automated axe, reflow, minimum-text, target-size, keyboard-menu, and reduced-motion checks run in Playwright. They do not establish assistive-technology conformance. Complete this protocol against the exact staging commit before admitting pilot guests and again after any navigation, room-control, provider, or publishing UI change.

## Safety and evidence rules

- Use a dedicated staging host, disposable room, and synthetic track names. Never record a real invite capability, passkey challenge, recovery code, Music User Token, provider token, or private playlist URL.
- Record the commit SHA, deployment URL, browser/OS/assistive-technology versions, viewport or zoom, tester, date, and result for every run.
- Save redacted screenshots or short recordings for failures. Link evidence from the table at the end of this document; do not place sensitive values in filenames.
- Stop the pilot for a keyboard trap, inaccessible security prompt, unannounced destructive/provider result, unreachable room control, content loss at 400% zoom, or any serious/critical axe finding.

## Keyboard-only completion

Run in both desktop Chromium and desktop Safari without a mouse or trackpad.

1. From the landing page, press Tab. Confirm visible focus, activate “Skip to main content,” then reach guest and host entry points in a logical order.
2. Sign in with a pilot passkey. Cancel the platform prompt once and confirm the error is announced and the button remains operable; repeat and complete sign-in.
3. Create a room. Operate both radiogroups with Tab, arrow keys, Home, and End. Confirm only the selected radio is in the Tab order. Complete every select and submit the form.
4. Copy the guest invite and enter the room. At a narrow viewport, open the navigation, Tab through only visible items, press Escape, and confirm focus returns to “Open navigation.”
5. In a separate guest browser profile, exchange the invite, choose a service preference with arrow keys, enter a nickname, and join. Confirm the URL fragment disappears before any interaction.
6. Submit a direct provider link and a plain-text pick. Exercise matched, held, no-match, rate-limited, and network-error responses. Confirm each result is announced once and the input remains recoverable.
7. As host, review a pending pick, approve it, confirm playback, vote/co-sign, skip or advance by occurrence, and open the recap. Confirm focus is never reset to the page start after a command refresh.
8. Open Connections. With one provider status request failed, use its Retry control while the other provider remains operable. Confirm a failed connect or disconnect is announced as an error, not success.
9. Complete each enabled publishing destination independently. Confirm preview identity, confirmation, queued status, partial failure, retry, cancel, and published links are reachable and understandable without color or pointer location.

## VoiceOver with Safari

Run on the current pilot macOS/Safari release. Repeat the guest join on iOS Safari if phones are in the pilot.

1. Enable VoiceOver before loading the page. Navigate by landmarks and headings; confirm one main landmark, a named host navigation landmark, a meaningful page heading, and no host navigation in a guest session.
2. Confirm passkey, recovery, and enrollment modes announce their heading, instructions, field labels, busy state, cancellation, and error. Verify recovery codes are read as an ordered list and “Copy all codes” reports the result.
3. In room creation and guest join, confirm each segmented control announces “radio group,” option name, selected state, and position/count. Verify arrow-key selection follows focus.
4. In the living setlist, navigate Now, Next, Staged, Held, and Played content. Confirm track title, submitter, co-sign/vote count, occurrence action, disabled state, and playback-confirmation requirement are distinguishable.
5. Trigger one successful and one failed room command. Confirm each message is announced exactly once without moving the VoiceOver cursor.
6. Verify provider names, connection state, storefront, publishing state, new-tab behavior, retry controls, and error recovery. Provider artwork must have concise licensed-context alternatives and no duplicate adjacent name.
7. Verify recap order and every publishing operation/status. A destination failure must not be announced as failure of the other destination or of the room.

## NVDA with Chrome

Run on the current pilot Windows/Chrome/NVDA releases with speech viewer enabled for redacted evidence.

1. Repeat the complete host and guest flows above using browse mode, focus mode, H/1-6 headings, D landmarks, F forms, B buttons, and K links.
2. Verify all labels and instructions are available before each input; required and disabled states are announced; the off-canvas navigation is absent while closed.
3. Confirm live command, resolver, provider, and publishing feedback is announced once. Check that rapid sequential updates do not overwrite an error before it is heard.
4. Switch to Windows High Contrast/forced colors. Confirm focus, selected radio, held state, current cue, success, warning, and error remain perceivable without their authored colors.

## Zoom, reflow, motion, and targets

1. At 200% browser zoom, complete guest join, contribution, host review, playback confirmation, Connections, recap, and publishing with no horizontal page scrolling.
2. At 400% browser zoom and a 1280px-wide window, repeat every critical action. Two-dimensional scrolling is acceptable only inside content that inherently requires it; UniJam currently has no such pilot content.
3. At a 320 CSS-pixel viewport, confirm no text truncates essential identity or status, no control overlaps, and sticky/off-canvas UI leaves the focused control visible.
4. Enable reduced motion at OS level before page load. Confirm cue and reconnect indicators do not pulse or blink continuously and focus/command state never depends on animation.
5. Measure any control that fails the automated target gate on a real touch device. Every pilot control must provide at least a 44-by-44 CSS-pixel target without overlapping another target.

## Evidence template

| Build / deployment | Environment | Browser + OS | AT / setting | Flow | Result | Evidence / issue | Tester / date |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SHA` / staging URL | staging | Safari / macOS | VoiceOver | Host full flow | Not run | — | — |
| `SHA` / staging URL | staging | Safari / iOS | VoiceOver | Guest full flow | Not run | — | — |
| `SHA` / staging URL | staging | Chrome / Windows | NVDA | Host + guest full flow | Not run | — | — |
| `SHA` / staging URL | staging | Chrome / Windows | Forced colors | Critical states | Not run | — | — |
| `SHA` / staging URL | staging | Safari + Chrome | 200% / 400% zoom | Critical flows | Not run | — | — |
| `SHA` / staging URL | staging | Safari + Chrome | Reduced motion | Live room | Not run | — | — |

The release owner signs off only when every row is Pass or has an accepted, non-critical issue linked to an owner and fix date. “Not run” is a release blocker, not an implicit pass.
