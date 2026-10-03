// 画面なしで自動プレイを走らせ、最後まで避け切れた回数を出す。
// 避け切れない回があれば、避けられない波が出ている。
// 使い方: npm run sim -- [回数] [最初の種] [打ち切る秒数]
import { CUBE, FLAT, TICKS_PER_SECOND } from '../src/game/rules';
import { playMany } from '../src/game/sim';

const games = Number(process.argv[2] ?? 1000);
const firstSeed = Number(process.argv[3] ?? 1);
const seconds = Number(process.argv[4] ?? 120);
const maxTicks = seconds * TICKS_PER_SECOND;

console.log(`${games} 回（種 ${firstSeed}〜${firstSeed + games - 1}）・${seconds} 秒で打ち切り`);
for (const [name, config] of [['平面 3x3', FLAT], ['立体 3x3x3', CUBE]] as const) {
  const started = performance.now();
  const bot = playMany(games, firstSeed, { config, maxTicks });
  const idle = playMany(games, firstSeed, { config, maxTicks, moveEvery: 0 });
  const ms = Math.round(performance.now() - started);
  const sec = (ticks: number) => (ticks / TICKS_PER_SECOND).toFixed(1);
  console.log(`${name}  ${ms}ms`);
  console.log(`  自動プレイ: 避け切った ${bot.survived}/${games}、いちばん短い回 ${sec(bot.shortest)} 秒`);
  console.log(`  動かない時: 避け切った ${idle.survived}/${games}、いちばん短い回 ${sec(idle.shortest)} 秒`);
}
