import type { Metadata } from 'next';
import cesiumPackage from 'cesium/package.json';
import CesiumTheater from '@/components/theater/CesiumTheater';
import './theater.css';

export const metadata: Metadata = { title: 'Lookout — 3D' };

// The engine's version is part of its asset path (/vendor/cesium/<version>/), so it
// is read here on the server and handed down rather than shipped as JSON to the browser.
export default function TheaterPage() {
  return <CesiumTheater cesiumVersion={cesiumPackage.version} />;
}
