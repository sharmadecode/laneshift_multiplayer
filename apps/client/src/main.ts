import './style.css';
import { Game } from './game/Game';
import { initOrientationLock } from './game/Orientation';

export const BUILD_TAG = 'build-o11-rooms';

console.log(`LaneShifter: Multiplayer ${BUILD_TAG}`);

initOrientationLock();

const app = document.getElementById('app');
if (app) {
  new Game(app).start();
}
