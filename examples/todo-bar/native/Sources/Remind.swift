import AppKit
import UserNotifications

// Reminders as real notifications, with Done and Snooze buttons. Snooze
// works without the page: the shell sets the next one itself.
final class Reminders: NSObject, UNUserNotificationCenterDelegate {
  static let shared = Reminders()
  weak var shell: Shell?
  let center = UNUserNotificationCenter.current()

  func start(_ s: Shell) {
    shell = s
    center.delegate = self
    center.setNotificationCategories([
      UNNotificationCategory(
        identifier: "todo",
        actions: [
          UNNotificationAction(identifier: "done", title: "Mark as Done",
                               icon: UNNotificationActionIcon(systemImageName: "checkmark.circle")),
          UNNotificationAction(identifier: "snooze", title: "Snooze",
                               icon: UNNotificationActionIcon(systemImageName: "clock.arrow.circlepath")),
        ],
        intentIdentifiers: [])
    ])
  }

  func add(id: String, text: String, after secs: Double, snooze: Int) {
    let c = UNMutableNotificationContent()
    c.title = text
    c.body = "Reminder from \(Config.name)"
    c.sound = .default
    c.categoryIdentifier = "todo"
    c.userInfo = ["snooze": snooze]
    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, secs), repeats: false)
    center.add(UNNotificationRequest(identifier: id, content: c, trigger: trigger))
  }

  // Show the banner even when the app is in front.
  func userNotificationCenter(
    _ c: UNUserNotificationCenter, willPresent n: UNNotification,
    withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    shell?.emitRemindFired(RemindFired(id: n.request.identifier))
    done([.banner, .sound])
  }

  func userNotificationCenter(
    _ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
    withCompletionHandler done: @escaping () -> Void
  ) {
    let req = r.notification.request
    DispatchQueue.main.async {
      switch r.actionIdentifier {
      case "done": self.shell?.emitRemindDone(RemindDone(id: req.identifier))
      case "snooze":
        let mins = req.content.userInfo["snooze"] as? Int ?? 10
        self.add(id: req.identifier, text: req.content.title, after: Double(mins) * 60, snooze: mins)
      default:
        // A click on the banner itself: show the list.
        self.shell?.emitRemindFired(RemindFired(id: req.identifier))
        self.shell?.showPanel()
      }
      done()
    }
  }
}

extension Shell {
  func remindSet(_ a: RemindSetArgs) async throws -> Bool {
    // Test runs never ask: the prompt would wait for a person.
    if testing { return false }
    let c = Reminders.shared.center
    let s = await c.notificationSettings()
    if s.authorizationStatus == .notDetermined {
      guard (try? await c.requestAuthorization(options: [.alert, .sound])) == true else { return false }
    } else if s.authorizationStatus == .denied {
      return false
    }
    Reminders.shared.add(id: a.id, text: a.text, after: a.minutes * 60, snooze: a.snooze)
    return true
  }

  func remindCancel(_ a: RemindCancelArgs) {
    Reminders.shared.center.removePendingNotificationRequests(withIdentifiers: [a.id])
    Reminders.shared.center.removeDeliveredNotifications(withIdentifiers: [a.id])
  }
}
