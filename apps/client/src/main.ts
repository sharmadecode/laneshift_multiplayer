import './style.css';
import { Game } from './game/Game';
import { initOrientationLock } from './game/Orientation';

export const BUILD_TAG = 'build-o8-settings-design';

console.log(`Highway Rush ${BUILD_TAG}`);

initOrientationLock();

const app = document.getElementById('app');
if (app) {
  new Game(app).start();
}
