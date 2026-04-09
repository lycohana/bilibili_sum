module.exports = {
  appId: "com.briefvid.desktop",
  productName: "BriefVid",
  artifactName: "${productName}-${version}-${os}-${arch}-Setup.${ext}",
  directories: {
    output: "../../dist/desktop"
  },
  files: [
    "dist-electron/**/*"
  ],
  extraResources: [
    {
      "from": "../../dist/BriefVid",
      "to": "backend/BriefVid"
    },
    {
      "from": "../../apps/desktop/build/icon.ico",
      "to": "icon.ico"
    }
  ],
  win: {
    "target": [
      {
        "target": "nsis",
        "arch": [
          "x64"
        ]
      }
    ],
    "icon": "../../apps/desktop/build/icon.ico",
    "sign": null,
    "signAndEditExecutable": true,
    "signDlls": false,
    "requestedExecutionLevel": "asInvoker",
    "fileAssociations": []
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    allowElevation: true,
    createDesktopShortcut: true,
    perMachine: false,
    shortcutName: "BriefVid",
    uninstallDisplayName: "BriefVid",
    installerIcon: "../../apps/desktop/build/icon.ico",
    uninstallerIcon: "../../apps/desktop/build/icon.ico"
  },
  publish: {
    provider: "github",
    owner: "lycohana",
    repo: "BriefVid",
    releaseType: "release"
  },
  // Disable code signing completely
  afterSign: null
};
