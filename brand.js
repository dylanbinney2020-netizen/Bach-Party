// =====================================================================
// QUYLE'S BRAND SETTINGS: the one file to edit for logos and colors.
//
// Leave a value as null to use the default. Image paths are relative to
// this folder, so put files in web/img/ and write 'img/your-file.png'.
// After editing, upload this file (and any new images) to GitHub.
// =====================================================================
window.BRAND = {
  // Event identity. Shown on the login screen, the home header and the
  // championship reveal. When eventLogo is set, it replaces the text logo.
  eventLogo: null,            // e.g. 'img/quyles-logo.png' (transparent PNG or SVG works best)
  eventName: "QUYLE'S",
  eventTagline: 'BACHELOR PARTY',
  location: 'ASHEVILLE, NORTH CAROLINA',
  dates: 'OCTOBER 9–12, 2026',
  year: '2026',

  // Team overrides, keyed by team number (1 = Team Quinn, 2 = Team Connor B,
  // 3 = Team Kyle). Anything set here wins over the commissioner's
  // Weekend > Teams settings. Leave null to use those settings instead.
  //   logo:      'img/team-quinn.png'
  //   primary:   main team color, e.g. '#1F4D7A'
  //   secondary: accent color, e.g. '#C9A45C'
  teams: {
    1: { logo: null, primary: null, secondary: null },
    2: { logo: null, primary: null, secondary: null },
    3: { logo: null, primary: null, secondary: null },
  },
};
