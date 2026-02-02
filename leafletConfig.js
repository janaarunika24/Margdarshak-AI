// src/leafletConfig.js
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

// important: remove the default _getIconUrl so we can override it
delete L.Icon.Default.prototype._getIconUrl;

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x?.src || markerIcon2x,
  iconUrl: markerIcon?.src || markerIcon,
  shadowUrl: markerShadow?.src || markerShadow,
});
