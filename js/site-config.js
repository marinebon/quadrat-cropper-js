/**
 * site-config.js — per-deployment settings, empty in this repository.
 *
 * A site that hosts its own copy of the tool can overwrite this file at
 * deploy time (e.g. from a CI variable) to give every visitor defaults that
 * should not live in the shared code. A value a user sets in ⚙ always wins.
 *
 *   arcgisKey: ArcGIS Location Platform API key (Basemaps privilege only,
 *              restricted to the site's domain) → Esri World Imagery in the
 *              Map tab without each user pasting a key.
 */
window.QD_SITE_CONFIG = {
  arcgisKey: ''
};
