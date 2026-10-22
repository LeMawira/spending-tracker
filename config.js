// Fill these in before first use. See README.md for how to get a Client ID.
window.APP_CONFIG = {
  // OAuth 2.0 Web Client ID from Google Cloud Console
  GOOGLE_CLIENT_ID: "491171972777-sa9347jvfc064c0h9m8pdv768910erg0.apps.googleusercontent.com",

  // Default bank sender addresses (can also be edited in the app's Settings).
  // Only emails FROM these addresses are ever requested from Gmail.
  DEFAULT_SENDERS: [
"infomail@imbank.co.ke",
  ],

  // How far back the very first sync looks, in days.
  FIRST_SYNC_DAYS: 30,

  // Fixed exchange rate used to combine AED and USD spending into one total.
  // Totals are estimates; change this if you want a different rate.
  USD_TO_AED: 3.6725,
};
