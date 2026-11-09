import UIKit
import Capacitor
import AuthenticationServices
import Security

/// The app's own native plugin (src/phone/native.ts is its JavaScript side). Three things the WebView can't do:
/// - `http`: requests CORS doesn't apply to, to a fixed list of hosts, bodies as base64 both ways and the answer's bytes
///   exactly as they arrived (Capacitor's own HTTP plugin parses any application/json answer, which would break the
///   sha-256 check on Drive files).
/// - `signIn`: Google's sign-in in ASWebAuthenticationSession (Google refuses sign-in inside a WKWebView).
/// - `secretGet`/`secretSet`/`secretDelete`: the Keychain, this device only, readable after the first unlock.
@objc(HindsightNativePlugin)
public class HindsightNativePlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "HindsightNativePlugin"
    public let jsName = "HindsightNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "http", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretDelete", returnType: CAPPluginReturnPromise),
    ]

    /// The same list as NATIVE_HOSTS in src/phone/native-fetch.ts.
    static let hosts: Set<String> = ["www.googleapis.com", "oauth2.googleapis.com", "www.thebluealliance.com", "frc.nexus"]

    /// No cache and no cookies: every read asks the server, and nothing a server sets outlives the app.
    private let session = URLSession(configuration: .ephemeral)
    private var signInSession: ASWebAuthenticationSession?

    // MARK: HTTP

    @objc func http(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text), url.scheme == "https",
              let host = url.host, HindsightNativePlugin.hosts.contains(host) else {
            call.reject("not sent: not a host the phone talks to", "REFUSED")
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        request.httpMethod = call.getString("method") ?? "GET"
        for (name, value) in call.getObject("headers") ?? [:] {
            if let value = value as? String { request.setValue(value, forHTTPHeaderField: name) }
        }
        // A ranged read must come back as the stored bytes, not a compressed slice.
        if request.value(forHTTPHeaderField: "Range") != nil { request.setValue("identity", forHTTPHeaderField: "Accept-Encoding") }
        if let body = call.getString("body") {
            guard let data = Data(base64Encoded: body) else { call.reject("the body is not base64", "BAD_BODY"); return }
            request.httpBody = data
        }
        session.dataTask(with: request) { data, response, error in
            if let error = error { call.reject(error.localizedDescription, "NETWORK"); return }
            guard let http = response as? HTTPURLResponse else { call.reject("no HTTP answer", "NETWORK"); return }
            var headers: [String: String] = [:]
            for (name, value) in http.allHeaderFields { headers[String(describing: name).lowercased()] = String(describing: value) }
            call.resolve(["status": http.statusCode, "headers": headers, "body": (data ?? Data()).base64EncodedString()])
        }.resume()
    }

    // MARK: Sign-in

    @objc func signIn(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text), url.scheme == "https", url.host == "accounts.google.com",
              let scheme = call.getString("scheme"), !scheme.isEmpty else {
            call.reject("signIn needs a Google https url and a callback scheme", "BAD_ARGS")
            return
        }
        DispatchQueue.main.async {
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callback, error in
                self?.signInSession = nil
                if let callback = callback { call.resolve(["url": callback.absoluteString]); return }
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    call.reject("sign-in closed", "CANCELLED")
                    return
                }
                call.reject(error?.localizedDescription ?? "sign-in failed", "FAILED")
            }
            session.presentationContextProvider = self
            // Shares Safari's Google sign-in, so someone already signed in there only picks the account.
            session.prefersEphemeralWebBrowserSession = false
            self.signInSession = session
            if !session.start() {
                self.signInSession = nil
                call.reject("could not open the sign-in", "FAILED")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    // MARK: Keychain

    private func keychainQuery(_ call: CAPPluginCall) -> [String: Any]? {
        guard let key = call.getString("key"), key.range(of: "^[a-z][a-z.]{0,63}$", options: .regularExpression) != nil else {
            call.reject("a key is lower-case letters and dots", "BAD_KEY")
            return nil
        }
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "io.github.kevinclark.hindsight", kSecAttrAccount as String: key]
    }

    @objc func secretGet(_ call: CAPPluginCall) {
        guard var query = keychainQuery(call) else { return }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = found as? Data, let value = String(data: data, encoding: .utf8) else {
            call.reject("Keychain read failed (\(status))", "KEYCHAIN")
            return
        }
        call.resolve(["value": value])
    }

    @objc func secretSet(_ call: CAPPluginCall) {
        guard var query = keychainQuery(call) else { return }
        guard let value = call.getString("value") else { call.reject("no value", "BAD_ARGS"); return }
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = Data(value.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecSuccess { call.resolve() } else { call.reject("Keychain write failed (\(status))", "KEYCHAIN") }
    }

    @objc func secretDelete(_ call: CAPPluginCall) {
        guard let query = keychainQuery(call) else { return }
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound { call.resolve() } else { call.reject("Keychain delete failed (\(status))", "KEYCHAIN") }
    }
}

/// The bridge with the app's own plugin registered (SceneDelegate makes this its root).
class HindsightViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HindsightNativePlugin())
    }
}
