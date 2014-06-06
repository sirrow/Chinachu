// # Chinachu Operator Service (chinachu-operator)

/// <reference path="ref/node.d.ts"/>
'use strict';

var CONFIG_PATH = process.env.CHINACHU_CONFIG_PATH || 'config.json';
var DATA_DIR    = process.env.CHINACHU_DATA_DIR    || 'data/';

var RESERVES_DATA_PATH = DATA_DIR + 'reserves.json';
var RECORDS_DATA_PATH  = DATA_DIR + 'records.json';

import path          = require('path');
import fs            = require('fs');
import util          = require('util');
import child_process = require('child_process');
import akari         = require('akari');
var dateFormat       = require('dateformat');
var mkdirp           = require('mkdirp');

if (!fs.existsSync(CONFIG_PATH) || !fs.existsSync(RESERVES_DATA_PATH) || !fs.existsSync(RECORDS_DATA_PATH)) {
    util.error('Fatal: Required directory does not exist or current working directory is invalid.');
    process.exit(1);
}

// A last resort
process.on('uncaughtException', (err) => {
    akari.log(akari.LOG_ERROR, 'uncaughtException: ' + err.stack);
});

try {
    var config = require(CONFIG_PATH);
} catch (e) {
    util.error('Config Error: ' + e);
    process.exit(1);
}

var reserves  = [];
var records   = [];
var recording = [];

var schedulerProcessTime    = config.operSchedulerProcessTime    || 1000 * 60 * 20;//20分
var schedulerIntervalTime   = config.operSchedulerIntervalTime   || 1000 * 60 * 60;//60分
var schedulerSleepStartHour = config.operSchedulerSleepStartHour || 1;
var schedulerSleepEndHour   = config.operSchedulerSleepEndHour   || 5;
var schedulerEpgRecordTime  = config.schedulerEpgRecordTime      || 60;
var prepTime    = config.operRecPrepTime    || 1000 * 60;//60秒
var offsetStart = config.operRecOffsetStart || 1000 * 5;
var offsetEnd   = config.operRecOffsetEnd   || -(1000 * 8);

var clock     = new Date().getTime();
var next      = 0;
var scheduler = null;
var scheduled = 0;

// 録画コマンドのシリアライズ
var operRecCmdSpan  = config.operRecCmdSpan || 0;
if (operRecCmdSpan < 0) {
	operRecCmdSpan = 0;
}
var recCmdLastTime = new Date().getTime();
function execRecCmd(cmd, timeout, msg) {
	if (timeout > 0) {
		setTimeout(execRecCmd, timeout, cmd, 0, msg);
		return;
	}
	var t = operRecCmdSpan - (new Date().getTime() - recCmdLastTime);
	if (t > 0) {
		util.log(msg + ': ' + t + 'ms');
		setTimeout(execRecCmd, t, cmd, 0, msg);
		return;
	}
	cmd();
	recCmdLastTime = new Date().getTime();
}

// 録画中か
function isRecording(program) {
	var i, l;
	for (i = 0, l = recording.length; i < l; i++) {
		if (recording[i].id === program.id) {
			return true;
		}
	}
	
	return false;
}

// 録画したか
function isRecorded(program) {
	var i, l;
	for (i = 0, l = recorded.length; i < l; i++) {
		if (recorded[i].id === program.id) {
			return true;
		}
	}
	
	return false;
}

// 録画中の番組を更新
function recordingUpdater(program) {
	var i, l, k;
	for (i = 0, l = recording.length; i < l; i++) {
		if (recording[i].id === program.id) {
			for (k in program) {
				if (program.hasOwnProperty(k)) {
					recording[i][k] = program[k];
				}
			}
			return;
		}
	}
}

// スケジューラーを停止
function stopScheduler() {
	process.removeListener('SIGINT',  stopScheduler);
	process.removeListener('SIGQUIT', stopScheduler);
	process.removeListener('SIGTERM', stopScheduler);
	
	if (scheduler === null) { return; }
	
	scheduler.kill('SIGQUIT');
	util.log('KILL: SIGQUIT -> Scheduler (pid=' + scheduler.pid + ')');
}

// スケジューラーを開始
function startScheduler() {
	if ((scheduler !== null) || (recording.length !== 0)) { return; }
	
	var output, finalize;
	
	scheduler = child_process.spawn('node', [ 'app-scheduler.js', '-f' ]);
	util.log('SPAWN: node app-scheduler.js -f (pid=' + scheduler.pid + ')');
	
	// ログ用
	output = fs.createWriteStream('./log/scheduler', { flags: 'a' });
	util.log('STREAM: ./log/scheduler');
	
	finalize = function () {
		try {
			process.removeListener('SIGINT', stopScheduler);
			process.removeListener('SIGQUIT', stopScheduler);
			process.removeListener('SIGTERM', stopScheduler);
		} catch (e) {}
		
		try { output.end(); } catch (ee) {}
		
		scheduler = null;
	};
	
	scheduler.stdout.on('data', function (data) {
		try {
			output.write(data);
		} catch (e) {
			util.log('ERROR: Scheduler -> Abort (' + e + ')');
			finalize();
		}
	});
	
	scheduler.once('exit', finalize);
	
	process.once('SIGINT', stopScheduler);
	process.once('SIGQUIT', stopScheduler);
	process.once('SIGTERM', stopScheduler);
}

// 録画実行
function doRecord(program) {
	var timeout, tuner, recPath, recDirPath, recCmd, recProc, recFile, /*epgInterval, */finalize;
	
	util.log('RECORD: ' + dateFormat(new Date(program.start), 'isoDateTime') + ' [' + program.channel.name + '] ' + program.title);
	
	timeout = program.end - new Date().getTime() + offsetEnd;
	
	if (timeout < 0) {
		util.log('FATAL: 時間超過による録画中止');
		
		// 状態を更新
		recording.splice(recording.indexOf(program), 1);
		fs.writeFileSync(RECORDING_DATA_FILE, JSON.stringify(recording));
		util.log('WRITE: ' + RECORDING_DATA_FILE);
		return;
	}
	
	// チューナーを選ぶ
	tuner = chinachu.getFreeTunerSync(config.tuners, program.channel.type);
	
	// チューナーが見つからない
	if (tuner === null) {
		util.log('WARNING: ' + program.channel.type + ' 利用可能なチューナーが見つかりません (存在しないかロックされています) (5秒後に再試行)');
		setTimeout(function () {
			doRecord(program);
		}, 5000);
		return;
	}
	
	// チューナーをロック
	try {
		chinachu.lockTunerSync(tuner);
	} catch (e) {
		util.log('WARNING: チューナー(' + tuner.n + ')のロックに失敗しました');
	}
	util.log('LOCK: ' + tuner.name + ' (n=' + tuner.n + ')');
	
	program.tuner = tuner;
	
	// 保存先パス
	recPath = config.recordedDir + chinachu.formatRecordedName(program, config.recordedFormat);
	program.recorded = recPath;
	
	// 保存先ディレクトリ
	recDirPath = recPath.replace(/^(.+)\/.+$/, '$1');
	if (!fs.existsSync(recDirPath)) {
		util.log('MKDIR: ' + recDirPath);
		mkdirp.sync(recDirPath);
	}
	
	// 録画コマンド
	recCmd = tuner.command;
	// recCmd = recCmd.replace(' --strip', '');// EPGのSIDが消えてしまうバグへの対策(要調査)
	recCmd = recCmd.replace('<sid>', program.channel.sid + ',epg');
	recCmd = recCmd.replace('<channel>', program.channel.channel);
	program.command = recCmd;
	
	execRecCmd(function() {
		// 録画プロセスを生成
		recProc = child_process.spawn(recCmd.split(' ')[0], recCmd.replace(/[^ ]+ /, '').split(' '));
		chinachu.writeTunerPid(tuner, recProc.pid);
		util.log('SPAWN: ' + recCmd + ' (pid=' + recProc.pid + ')');
		program.pid = recProc.pid;
		
		// 状態保存
		fs.writeFileSync(RECORDING_DATA_FILE, JSON.stringify(recording));
		util.log('WRITE: ' + RECORDING_DATA_FILE);
		
		// 書き込みストリームを作成
		recFile = fs.createWriteStream(recPath, { flags: 'a' });
		util.log('STREAM: ' + recPath);
		
		// ts出力
		recProc.stdout.pipe(recFile);
		
		// ログ出力
		recProc.stderr.on('data', function (data) {
			util.log('#' + (recCmd.split(' ')[0] + ': ' + data).replace(/\n/g, ' ').trim());
		});
		
		// EPG処理
		/* 廃止: EPGパーサーに再実装予定
		epgInterval = setInterval(function () {
			var epgProc, output;
			
			epgProc = child_process.spawn('node', [
				'app-scheduler.js', '-f', '-ch', program.channel.channel, '-l', recPath
			]);
			util.log('SPAWN: node app-scheduler.js -f -ch ' + program.channel.channel + ' -l ' + recPath + ' (pid=' + epgProc.pid + ')');
			
			// ログ用
			output = fs.createWriteStream('./log/scheduler', { flags: 'a' });
			util.log('STREAM: ./log/scheduler');
			
			epgProc.stdout.on('data', function (data) {
				output.write(data);
			});
			
			epgProc.on('exit', function () {
				output.end();
			});
		}, 1000 * 300);//300秒
		*/
		
		// お片付け
		finalize = function () {
			var i, l, postProcess;
			
			process.removeListener('SIGINT', finalize);
			process.removeListener('SIGQUIT', finalize);
			process.removeListener('SIGTERM', finalize);
			recProc.stdout.removeAllListeners();
			
			// 書き込みストリームを閉じる
			recFile.end();
			
			// チューナーのロックを解除
			try {
				chinachu.unlockTunerSync(tuner);
				util.log('UNLOCK: ' + tuner.name + ' (n=' + tuner.n + ')');
			} catch (e) {
				util.log(e);
			}
			
			// EPG処理を終了
			//clearInterval(epgInterval);
			
			// 状態を更新
			delete program.pid;
			recorded.push(program);
			recording.splice(recording.indexOf(program), 1);
			fs.writeFileSync(RECORDED_DATA_FILE, JSON.stringify(recorded));
			fs.writeFileSync(RECORDING_DATA_FILE, JSON.stringify(recording));
			util.log('WRITE: ' + RECORDED_DATA_FILE);
			util.log('WRITE: ' + RECORDING_DATA_FILE);
			if (program.isManualReserved) {
				for (i = 0, l = reserves.length; i < l; i++) {
					if (reserves[i].id === program.id) {
						reserves.splice(i, 1);
						fs.writeFileSync(RESERVES_DATA_FILE, JSON.stringify(reserves));
						util.log('WRITE: ' + RESERVES_DATA_FILE);
						break;
					}
				}
			}
			
			// ポストプロセス
			if (config.recordedCommand) {
				postProcess = child_process.spawn(config.recordedCommand, [recPath, JSON.stringify(program)]);
				util.log('SPAWN: ' + config.recordedCommand + ' (pid=' + postProcess.pid + ')');
			}
			
			finalize = null;
		};
		// 録画プロセス終了時処理
		recProc.on('exit', finalize);
		
		// 終了シグナル時処理
		process.on('SIGINT', finalize);
		process.on('SIGQUIT', finalize);
		process.on('SIGTERM', finalize);
	}, 0, 'RECWAIT: ' + tuner.name);
}

// 録画準備
function prepRecord(program) {
	util.log('PREPARE: ' + dateFormat(new Date(program.start), 'isoDateTime') + ' [' + program.channel.name + '] ' + program.title);

	program.isSigTerm = false;
	recording.push(program);
	
	var timeout = program.start - clock - offsetStart;
	if (timeout < 0) { timeout = 3000; }
	
	setTimeout(function () {
		doRecord(program);
	}, timeout);
	
	fs.writeFileSync(RECORDING_DATA_FILE, JSON.stringify(recording));
	util.log('WRITE: ' + RECORDING_DATA_FILE);
	
	if (scheduler !== null) {
		stopScheduler();
	}
}

// 予約時間チェック
function reservesChecker(program, i) {
	// スキップ
	if (program.isSkip) { return undefined; }
	
	// 予約時間超過
	if (clock > program.end) {
		next = 0;
		return;
	}
	
	// 予約準備時間内
	if (program.start - clock <= prepTime) {
		if (isRecording(program) === false && isRecorded(program) === false) {
			prepRecord(program);
		}
	}
	
	// 次の開始時間
	if (next === 0) {
		next = program.start;
	}
}

// 録画中チェック
function recordingChecker(program, i) {
	
	var timeout = program.end - clock + offsetEnd;
	
	// 録画時間内はreturn
	if (timeout >= 0) { return; }
	
	// 録画開始していない時はreturn
	if (!program.pid) { return; }
	
	execRecCmd(function() {
		if (program.isSigTerm || ((typeof program.pid) === 'undefined')) {	// WAITが入った際に多重にSIGTERM発行されないようにする
			return;
		}
		program.isSigTerm = true;
		util.log('FINISH: ' + dateFormat(new Date(program.start), 'isoDateTime') + ' [' + program.channel.name + '] ' + program.title);
		process.kill(program.pid, 'SIGTERM');
	}, 0, 'KILLWAIT: ' + program.pid);
}

// ファイル更新監視: ./data/reserves.json
chinachu.jsonWatcher(
	RESERVES_DATA_FILE,
	function _onUpdated(err, data, mes) {
		if (err) {
			util.error(err);
			return;
		}
		
		reserves = data;
		util.log(mes);
		
		if (recording.length > 0) {
			reserves.forEach(recordingUpdater);
			
			fs.writeFileSync(RECORDING_DATA_FILE, JSON.stringify(recording));
			util.log('WRITE: ' + RECORDING_DATA_FILE);
		}
	},
	{ create: [], now: true }
);
 
// ファイル更新監視: ./data/recorded.json
chinachu.jsonWatcher(
	RECORDED_DATA_FILE,
	function _onUpdated(err, data, mes) {
		if (err) {
			util.error(err);
			return;
		}
		
		recorded = data;
		util.log(mes);
	},
	{ create: [], now: true }
);

// main
function main() {
	try {
		clock = new Date().getTime();

		if (reserves.length !== 0) {
			reserves.forEach(reservesChecker);
		} else {
			next = 0;
		}

		recording.forEach(recordingChecker);

		if ((scheduler === null) && (clock - scheduled > schedulerIntervalTime) && ((next === 0) || (next - clock > schedulerProcessTime)) && ((schedulerSleepStartHour > new Date().getHours()) || (schedulerSleepEndHour <= new Date().getHours()))) {
			startScheduler();
			scheduled = clock;
		}
	} catch (e) {
		util.error('ERROR: ' + e.stack);
	}
}
setInterval(main, 1000);