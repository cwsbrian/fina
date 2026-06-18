// Dynamic Expo config layered on top of app.json.
//
// 1. Cleartext HTTP: enabled ONLY for dev/preview builds whose API URL is
//    plain http:// (e.g. the Tailscale/LAN dev server). Production uses
//    https://, so cleartext stays disabled there. On iOS this is limited to
//    local-network resources instead of allowing arbitrary HTTP loads.
// 2. Low-resource local builds: when FINA_LOCAL_BUILD=1 (set by the local
//    eas.json profiles), cap the Android build so `eas build --local` doesn't
//    exhaust RAM and thrash swap to a disk-I/O standstill on a small machine
//    (e.g. a ~10 GB WSL2). EAS cloud / production builds leave this unset and
//    keep full ABIs + parallelism.
const {
  withDangerousMod,
  withGradleProperties,
  withXcodeProject,
} = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const NATIVE_SUBSCRIPTION_STORE_SWIFT = `import Foundation
import React
import StoreKit
import SwiftUI
import UIKit

@available(iOS 17.0, *)
private struct FinaSubscriptionStoreSheet: View {
  let productIds: [String]
  let onClose: () -> Void

  var body: some View {
    NavigationStack {
      SubscriptionStoreView(productIDs: productIds)
        .subscriptionStoreButtonLabel(.multiline)
        .storeButton(.visible, for: .restorePurchases)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") {
              onClose()
            }
          }
        }
    }
  }
}

private final class FinaSubscriptionPresentationDelegate: NSObject, UIAdaptivePresentationControllerDelegate {
  private let resolve: RCTPromiseResolveBlock
  private let onFinish: () -> Void
  private var didFinish = false

  init(
    resolve: @escaping RCTPromiseResolveBlock,
    onFinish: @escaping () -> Void
  ) {
    self.resolve = resolve
    self.onFinish = onFinish
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish()
  }

  func finish() {
    guard !didFinish else { return }
    didFinish = true
    resolve(true)
    onFinish()
  }
}

@objc(FinaNativeSubscriptionStore)
class FinaNativeSubscriptionStore: NSObject {
  private var presentationDelegate: FinaSubscriptionPresentationDelegate?

  @objc
  static func requiresMainQueueSetup() -> Bool {
    true
  }

  @objc(present:resolver:rejecter:)
  func present(
    _ productIds: [String],
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard #available(iOS 17.0, *) else {
        reject("E_UNAVAILABLE", "Native App Store subscription selection requires iOS 17 or later.", nil)
        return
      }

      let ids = productIds.filter { !$0.isEmpty }
      guard !ids.isEmpty else {
        reject("E_NO_PRODUCTS", "No App Store subscription products were provided.", nil)
        return
      }

      guard self.presentationDelegate == nil else {
        reject("E_ALREADY_PRESENTING", "The App Store subscription sheet is already open.", nil)
        return
      }

      guard let presenter = self.topViewController() else {
        reject("E_NO_PRESENTING_VIEW_CONTROLLER", "Could not find a view controller to present subscriptions.", nil)
        return
      }

      let delegate = FinaSubscriptionPresentationDelegate(resolve: resolve) { [weak self] in
        self?.presentationDelegate = nil
      }
      let controller = UIHostingController(
        rootView: FinaSubscriptionStoreSheet(productIds: ids, onClose: {})
      )
      controller.rootView = FinaSubscriptionStoreSheet(productIds: ids) { [weak controller, weak delegate] in
        controller?.dismiss(animated: true) {
          delegate?.finish()
        }
      }
      self.presentationDelegate = delegate
      controller.modalPresentationStyle = .formSheet
      controller.presentationController?.delegate = delegate
      presenter.present(controller, animated: true)
    }
  }

  private func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let keyWindow = scenes
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }

    var top = keyWindow?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }

    if let nav = top as? UINavigationController {
      return nav.visibleViewController
    }
    if let tab = top as? UITabBarController {
      return tab.selectedViewController
    }
    return top
  }
}
`;

const NATIVE_SUBSCRIPTION_STORE_BRIDGE = `#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(FinaNativeSubscriptionStore, NSObject)

RCT_EXTERN_METHOD(present:(NSArray *)productIds
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
`;

/** Set (replacing any existing) a gradle.properties key. */
function setGradleProperty(props, key, value) {
  const next = props.filter(
    (item) => !(item.type === "property" && item.key === key),
  );
  next.push({ type: "property", key, value });
  return next;
}

/** Cap Gradle heap + worker parallelism for low-RAM local builds. The big RAM
 *  saver is the single-ABI limit (set via expo-build-properties below); this
 *  keeps the Gradle daemon + concurrent task count from piling on top of the
 *  native (CMake/ninja) compile. */
const withLocalBuildLimits = (config) =>
  withGradleProperties(config, (cfg) => {
    // One ABI instead of all four cuts the New-Architecture C++ compile ~4x —
    // the phase that otherwise exhausts RAM. Set it here (not via
    // expo-build-properties, whose reactNativeArchitectures option did NOT take
    // effect — the prebuild template's default won) so this mod, which runs
    // last, overwrites the default. arm64-v8a covers modern test devices + the
    // Play internal track.
    cfg.modResults = setGradleProperty(
      cfg.modResults,
      "reactNativeArchitectures",
      "arm64-v8a",
    );
    cfg.modResults = setGradleProperty(
      cfg.modResults,
      "org.gradle.jvmargs",
      "-Xmx4096m -XX:MaxMetaspaceSize=1024m",
    );
    cfg.modResults = setGradleProperty(cfg.modResults, "org.gradle.workers.max", "2");
    cfg.modResults = setGradleProperty(cfg.modResults, "org.gradle.parallel", "false");
    return cfg;
  });

const withIosModularHeaders = (config) =>
  withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
      const podfile = await fs.promises.readFile(podfilePath, "utf8");

      if (podfile.includes("use_modular_headers!")) {
        return cfg;
      }

      const nextPodfile = podfile.replace(
        /^(\s*platform\s+:ios,[^\n]*\n)/m,
        "$1use_modular_headers!\n",
      );

      if (nextPodfile === podfile) {
        throw new Error("Unable to insert use_modular_headers! into ios/Podfile");
      }

      await fs.promises.writeFile(podfilePath, nextPodfile);
      return cfg;
    },
  ]);

function findXcodeGroupKey(project, groupName) {
  const groups = project.hash.project.objects.PBXGroup;
  for (const key of Object.keys(groups)) {
    if (!key.endsWith("_comment")) continue;
    if (groups[key] === groupName) return key.replace("_comment", "");
  }
  return null;
}

function ensureXcodeSource(project, groupKey, filePath) {
  if (project.hasFile(filePath)) return;
  project.addSourceFile(filePath, {}, groupKey);
}

const withNativeSubscriptionStore = (config) => {
  config = withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const projectName = cfg.modRequest.projectName;
      const projectDir = path.join(cfg.modRequest.platformProjectRoot, projectName);
      await fs.promises.mkdir(projectDir, { recursive: true });
      await fs.promises.writeFile(
        path.join(projectDir, "FinaNativeSubscriptionStore.swift"),
        NATIVE_SUBSCRIPTION_STORE_SWIFT,
      );
      await fs.promises.writeFile(
        path.join(projectDir, "FinaNativeSubscriptionStoreBridge.m"),
        NATIVE_SUBSCRIPTION_STORE_BRIDGE,
      );
      return cfg;
    },
  ]);

  return withXcodeProject(config, (cfg) => {
    const projectName = cfg.modRequest.projectName;
    const groupKey = findXcodeGroupKey(cfg.modResults, projectName);
    if (!groupKey) {
      throw new Error(`Unable to find ${projectName} group in ios project`);
    }

    ensureXcodeSource(
      cfg.modResults,
      groupKey,
      `${projectName}/FinaNativeSubscriptionStore.swift`,
    );
    ensureXcodeSource(
      cfg.modResults,
      groupKey,
      `${projectName}/FinaNativeSubscriptionStoreBridge.m`,
    );
    return cfg;
  });
};

function googleIosUrlScheme(clientId) {
  if (!clientId || !clientId.endsWith(".apps.googleusercontent.com")) return "";
  return `com.googleusercontent.apps.${clientId.replace(".apps.googleusercontent.com", "")}`;
}

module.exports = ({ config }) => {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL || "";
  const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || "";
  const googleUrlScheme = googleIosUrlScheme(googleIosClientId);
  const allowLocalNetworking = process.env.FINA_IOS_ALLOW_LOCAL_NETWORKING === "1";
  const allowCleartext = apiUrl.startsWith("http://") || allowLocalNetworking;
  const lowResource = process.env.FINA_LOCAL_BUILD === "1";

  // expo-build-properties is only needed for cleartext HTTP (its
  // reactNativeArchitectures option didn't take effect — the ABI limit is set
  // in withLocalBuildLimits via gradle.properties instead).
  if (allowCleartext) {
    config.ios = config.ios || {};
    config.ios.infoPlist = {
      ...(config.ios.infoPlist || {}),
      NSAppTransportSecurity: {
        ...(config.ios.infoPlist?.NSAppTransportSecurity || {}),
        NSAllowsLocalNetworking: true,
      },
      NSLocalNetworkUsageDescription:
        "Fina connects to a local development server while testing development builds.",
    };
    config.plugins = [
      ...(config.plugins || []),
      ["expo-build-properties", { android: { usesCleartextTraffic: true } }],
    ];
  }

  if (googleUrlScheme) {
    config.plugins = [
      ...(config.plugins || []),
      [
        "@react-native-google-signin/google-signin",
        { iosUrlScheme: googleUrlScheme },
      ],
    ];
  }

  if (lowResource) {
    config = withLocalBuildLimits(config);
  }

  config = withIosModularHeaders(config);
  config = withNativeSubscriptionStore(config);

  return config;
};
