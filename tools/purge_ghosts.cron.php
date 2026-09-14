<?php
// Ghost signature purge for Tripwire.
//
// A ghost is a wormhole row the automapper created while following a pilot
// who was, in fact, taking stargates: both ends sit in known space, neither
// end carries a signature ID, the hole has no named type (blank or K162),
// and the two systems are within a few gate jumps of each other. Nobody
// scanned it; it is not a hole; it stays on the map until a human deletes it.
// This script deletes them on a schedule instead.
//
// Rows that match everything except the gate test are probably real holes
// nobody has identified yet. They are reported, never deleted.
//
// Needs tools/ghosts-universe.json beside it (known-space system IDs and
// stargate pairs; Tripwire's own database holds neither). Deletes go through
// the signatures table so the wormhole row cascades on its foreign key.
// Nothing is written to the _history_* tables: this build records nothing
// there for deletes made in the UI either. Every deletion is printed, so
// keep the log.
//
//   php tools/purge_ghosts.cron.php --dry-run          report only, change nothing
//   php tools/purge_ghosts.cron.php                    delete ghosts
//   options: --max-gates=3  --min-age=30 (minutes)  --mask=<corporationID>.2  --limit=200
//
// Cron, with the same shape as the other Tripwire jobs (see crontab-tw.txt):
//   23 * * * * docker exec -t php-fpm php /opt/app/tools/purge_ghosts.cron.php >> /tmp/tw-ghosts.log 2>&1
//
// --min-age keeps a hole a scout is still typing into off the list: a fresh
// row with no IDs yet is a scan in progress, not a ghost.

require(__DIR__ . '/../config.php');
require(__DIR__ . '/../db.inc.php');

$opts = [];
foreach (array_slice($argv, 1) as $arg) {
	if (preg_match('/^--([a-z-]+)(?:=(.*))?$/', $arg, $m)) $opts[$m[1]] = $m[2] ?? true;
}
$dryRun   = isset($opts['dry-run']);
$maxGates = max(0, (int)($opts['max-gates'] ?? 3));
$minAge   = max(0, (int)($opts['min-age'] ?? 30));
$onlyMask = isset($opts['mask']) ? (string)$opts['mask'] : null;
$limit    = max(1, (int)($opts['limit'] ?? 200));
$dataFile = $opts['data'] ?? (__DIR__ . '/ghosts-universe.json');
$label    = $dryRun ? 'ghosts (dry run)' : 'ghosts';
$say      = function (string $msg) use ($label) { echo date('Y-m-d H:i:s') . " $label: $msg\n"; };

if (!is_readable($dataFile)) { $say("cannot read $dataFile"); exit(1); }
$data = json_decode(file_get_contents($dataFile), true);
if (!$data || empty($data['kspace']) || empty($data['gates'])) { $say("$dataFile is not the expected shape"); exit(1); }
$kspace = array_fill_keys($data['kspace'], true);
$names  = $data['names'] ?? [];
$adj    = [];
foreach ($data['gates'] as [$a, $b]) { $adj[$a][] = $b; $adj[$b][] = $a; }

// Gate distance between two systems, or null when farther than $max.
$gateDistance = function (int $a, int $b, int $max) use ($adj): ?int {
	if ($a === $b) return 0;
	$seen = [$a => true];
	$frontier = [$a];
	for ($d = 1; $d <= $max && $frontier; $d++) {
		$next = [];
		foreach ($frontier as $sys) {
			foreach ($adj[$sys] ?? [] as $n) {
				if (isset($seen[$n])) continue;
				if ($n === $b) return $d;
				$seen[$n] = true;
				$next[] = $n;
			}
		}
		$frontier = $next;
	}
	return null;
};
$name = fn (int $id) => $names[$id] ?? (string)$id;
$age  = function (string $t) { $s = time() - strtotime($t); return $s >= 86400 ? floor($s / 86400) . 'd ' . floor(($s % 86400) / 3600) . 'h' : ($s >= 3600 ? floor($s / 3600) . 'h ' . floor(($s % 3600) / 60) . 'm' : floor($s / 60) . 'm'); };

// Candidates: no IDs on either end, no named type, both ends real systems.
$sql = "SELECT w.id AS wid, w.type AS wtype, w.maskID,
               a.id AS aid, a.systemID AS asys, a.lifeTime AS alife, a.createdByName AS ascanner,
               b.id AS bid, b.systemID AS bsys, b.lifeTime AS blife
        FROM wormholes w
        JOIN signatures a ON a.id = w.initialID
        JOIN signatures b ON b.id = w.secondaryID
        WHERE (w.type IS NULL OR w.type = '' OR UPPER(w.type) = 'K162')
          AND (a.signatureID IS NULL OR a.signatureID = '')
          AND (b.signatureID IS NULL OR b.signatureID = '')
          AND a.systemID >= 30000000 AND b.systemID >= 30000000"
     . ($onlyMask !== null ? " AND w.maskID = :mask" : "")
     . " ORDER BY a.lifeTime";
$stmt = $mysql->prepare($sql);
if ($onlyMask !== null) $stmt->bindValue(':mask', $onlyMask);
$stmt->execute();
$rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

$ghosts = []; $unidentified = []; $young = 0; $skipped = 0;
foreach ($rows as $r) {
	$a = (int)$r['asys']; $b = (int)$r['bsys'];
	if (!isset($kspace[$a]) || !isset($kspace[$b])) { $skipped++; continue; }
	$born = min(strtotime($r['alife']), strtotime($r['blife']));
	if (time() - $born < $minAge * 60) { $young++; continue; }
	$d = $gateDistance($a, $b, $maxGates);
	$r['gates'] = $d;
	if ($d === null) $unidentified[] = $r; else $ghosts[] = $r;
}

$say(sprintf('%d candidate rows: %d ghosts, %d unidentified (kept), %d younger than %d min (kept), %d not k-space', count($rows), count($ghosts), count($unidentified), $young, $minAge, $skipped));
foreach ($unidentified as $r) {
	$say(sprintf('  keep  #%d %s <-> %s  mask %s  scanner %s  age %s  (farther than %d gates: identify it)', $r['wid'], $name((int)$r['asys']), $name((int)$r['bsys']), $r['maskID'], $r['ascanner'], $age($r['alife']), $maxGates));
}

$deleted = 0;
$del = $mysql->prepare('DELETE FROM signatures WHERE id IN (:a, :b)');
foreach (array_slice($ghosts, 0, $limit) as $r) {
	$line = sprintf('#%d %s <-> %s  %d gate%s  mask %s  scanner %s  age %s', $r['wid'], $name((int)$r['asys']), $name((int)$r['bsys']), $r['gates'], $r['gates'] == 1 ? '' : 's', $r['maskID'], $r['ascanner'], $age($r['alife']));
	if ($dryRun) { $say("  would delete $line"); continue; }
	try {
		$mysql->beginTransaction();
		$del->bindValue(':a', (int)$r['aid'], PDO::PARAM_INT);
		$del->bindValue(':b', (int)$r['bid'], PDO::PARAM_INT);
		$del->execute();
		$mysql->commit();
		$deleted++;
		$say("  deleted $line");
	} catch (Throwable $e) {
		$mysql->rollBack();
		$say("  FAILED $line: " . $e->getMessage());
	}
}
if (count($ghosts) > $limit) $say(sprintf('  %d more ghosts left for the next run (--limit=%d)', count($ghosts) - $limit, $limit));
$say($dryRun ? sprintf('done, nothing changed (%d would go)', min(count($ghosts), $limit)) : "done, $deleted deleted");
