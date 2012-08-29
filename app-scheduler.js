/*!
 *  Chinachu Task Scheduler (chinachu-scheduler)
 *
 *  Copyright (c) 2012 Yuki KAN and Chinachu Project Contributors
 *  http://akkar.in/projects/chinachu/
**/

var CONFIG_FILE         = __dirname + '/config.json';
var RULES_FILE          = __dirname + '/rules.json';
var RESERVES_DATA_FILE  = __dirname + '/data/reserves.json';
var SCHEDULE_DATA_FILE  = __dirname + '/data/schedule.json';

// 標準モジュールのロード
var path          = require('path');
var fs            = require('fs');
var util          = require('util');
var child_process = require('child_process');

// ディレクトリチェック
if (!fs.existsSync('./data/') || !fs.existsSync('./log/') || !fs.existsSync('./web/')) {
	util.error('必要なディレクトリが存在しないか、カレントワーキングディレクトリが不正です。');
	process.exit(1);
}

// 追加モジュールのロード
var opts       = require('opts');
var xml2js     = require('xml2js');
var xmlParser  = new xml2js.Parser();
var dateFormat = require('dateformat');

// 引数
opts.parse([
	{
		short      : 'f',
		long       : 'force',
		description: '全てのデータを破棄して再取得します',
		value      : false,
		required   : false
	},
	{
		short      : 's',
		long       : 'simulation',
		description: 'シミュレーション。実際には保存されません',
		value      : false,
		required   : false
	}
], true);

// 設定の読み込み
var config   = JSON.parse( fs.readFileSync(CONFIG_FILE, 'ascii') );
var rules    = JSON.parse( fs.readFileSync(RULES_FILE, 'ascii') || '[]' );
var reserves = JSON.parse( fs.readFileSync(RESERVES_DATA_FILE, 'ascii') || '[]' );

// チャンネルリストと番組表
var channels = JSON.parse(JSON.stringify(config.channels));
var schedule = [];

// EPGデータを取得または番組表を読み込む
if (opts.get('f') || !fs.existsSync(SCHEDULE_DATA_FILE)) {
	getEpg();
} else {
	schedule = JSON.parse( fs.readFileSync(SCHEDULE_DATA_FILE, 'ascii'));
	scheduler();
}

// EPGデータを取得
function getEpg() {
	var i = 0;
	var c = 0;
	(function _loop() {
		var self = arguments.callee;
		
		function retry() {
			++c;
			setTimeout(self, 3000);
			util.log('-- (retry)');
		}
		
		function turn() {
			++i;
			c = 0;
			setTimeout(self, 3000);
			util.log('--');
		}
		
		function end() {
			if (!opts.get('s')) {
				fs.writeFileSync(SCHEDULE_DATA_FILE, JSON.stringify(schedule, null, '  '));
				util.log('WRITE: ' + SCHEDULE_DATA_FILE);
			}
			
			scheduler();
		}
		
		// おわる
		if (channels.length === i) {
			end();
			return;
		}
		
		// あきらめて次へ
		if (c === 3) {
			turn();
			return;
		}
		
		var channel = channels[i];
		util.log(JSON.stringify(channel));
		
		// チェック
		switch (channel.type) {
			case 'GR':
				break;
			case 'BS':
				for (var j = 0; schedule.length > j; j++) {
					if (schedule[j].channel === channel.channel) {
						turn();
						return;
					}
				}
				break;
			case 'CS':
				for (var j = 0; schedule.length > j; j++) {
					if (
						(schedule[j].channel === channel.channel) &&
						(schedule[j].sid === channel.sid)
					) {
						turn();
						return;
					}
				}
				break;
			default:
				// todo
				turn();
				return;
		}//<-- switch
		
		// チューナーを選ぶ
		var tuner = null;
		for (var j = 0; config.tuners.length > j; j++) {
			tuner = config.tuners[j];
			tuner.n = j;
			
			if (
				(tuner.types.indexOf(channel.type) === -1) ||
				(fs.existsSync('./data/tuner.' + tuner.n.toString(10) + '.lock') === true)
			) {
				tuner = null;
				continue;
			}
			
			break;
		}
		
		// チューナーが見つからない
		if (tuner === null) {
			retry();
			return;
		}
		
		// チューナーをロック
		fs.writeFileSync('./data/tuner.' + tuner.n.toString(10) + '.lock', '');
		util.log('LOCK: ' + tuner.name + ' (n=' + tuner.n.toString(10) + ')');
		
		var recPath = config.temporaryDir + 'chinachu-tmp-' + new Date().getTime().toString(36) + '.m2ts';
		
		var recCmd = tuner.command.replace('<channel>', channel.channel);
		
		// recpt1用
		recCmd = recCmd.replace(' --b25', '').replace(' --strip', '').replace(/ --sid [^ ]+/, '');
		
		// 録画プロセスを生成
		var recProc = child_process.spawn(recCmd.split(' ')[0], recCmd.replace(/[^ ]+ /, '').split(' '));
		util.log('SPAWN: ' + recCmd + ' (pid=' + recProc.pid + ')');
		
		// プロセスタイムアウト
		setTimeout(function() { recProc.kill('SIGKILL'); }, 1000 * 45);
		
		// 一時ファイルへの書き込みストリームを作成
		var recFile = fs.createWriteStream(recPath);
		util.log('WRITE: ' + recPath);
		
		// ts出力
		recProc.stdout.on('data', function(data) {
			recFile.write(data);
		});
		
		// ログ出力
		recProc.stderr.on('data', function(data) {
			util.log('#' + (recCmd.split(' ')[0] + ': ' + data + '').replace(/\n/g, ' ').trim());
		});
		
		// プロセス終了時
		recProc.on('exit', function(code) {
			// 書き込みストリームを閉じる
			recFile.end();
			
			// チューナーのロックを解除
			fs.unlinkSync('./data/tuner.' + tuner.n.toString(10) + '.lock');
			util.log('UNLOCK: ' + tuner.name + ' (n=' + tuner.n.toString(10) + ')');
			
			// epgdump
			var epgdumpCmd = [
				config.epgdumpPath,
				(function() {
					switch (channel.type) {
						case 'GR':
							return 'none';
						case 'BS':
							return '/BS';
						case 'CS':
						default:
							return '/CS';
					}
				})(),
				recPath,
				'-'
			].join(' ');
			
			var epgdumpProc = child_process.exec(epgdumpCmd, { maxBuffer: 4096000 }, function(err, stdout, stderr) {
				// 一時録画ファイル削除
				fs.unlinkSync(recPath);
				util.log('UNLINK: ' + recPath);
				
				if (err !== null) {
					util.log('EPG: Unknown error.');
					retry();
					return;
				}
				
				// epgdumpのXMLをパース
				xmlParser.parseString(stdout, function(err, result) {
					if (result === null) {
						util.log('EPG: Failed to parse. (result=null)');
						retry();
						return;
					}
					
					switch (channel.type) {
						case 'GR':
							result.channel.forEach(function(a) {
								var ch = {
									type   : channel.type,
									channel: channel.channel,
									name   : a['display-name']['#'],
									id     : a['@'].id,
									sid    : a['service_id']
								};
								
								ch.programs = convertPrograms(result.programme, JSON.parse(JSON.stringify(ch)));
								
								schedule.push(ch);
								
								util.log(
									'CHANNEL: ' + ch.type + '-' + ch.channel + ' ... ' +
									ch.id + ' (sid=' + ch.sid + ') ' +
									'(programs=' + ch.programs.length.toString(10) + ')' +
									' - ' + ch.name
								);
							});
							break;
						case 'BS':
							result.channel.forEach(function(a) {
								var isFound = false;
								
								for (var j = 0; channels.length > j; j++) {
									if (
										(channels[j].type === 'BS') &&
										(channels[j].channel === a['service_id'])
									) {
										isFound = true;
										break;
									} else {
										continue;
									}
								}
								
								if (isFound === false) { return; }
								
								var ch = {
									type   : channel.type,
									channel: a['service_id'],
									name   : a['display-name']['#'],
									id     : a['@'].id,
									sid    : a['service_id']
								};
								
								ch.programs = convertPrograms(result.programme, JSON.parse(JSON.stringify(ch)));
								
								schedule.push(ch);
								
								util.log(
									'CHANNEL: ' + ch.type + '-' + ch.channel + ' ... ' +
									ch.id + ' (sid=' + ch.sid + ') ' +
									'(programs=' + ch.programs.length.toString(10) + ')' +
									' - ' + ch.name
								);
							});
							break;
						case 'CS':
							result.channel.forEach(function(a) {
								var isFound = false;
								
								for (var j = 0; channels.length > j; j++) {
									if (
										(channels[j].type === 'CS') &&
										(channels[j].sid === a['service_id'])
									) {
										isFound = true;
										break;
									} else {
										continue;
									}
								}
								
								if (isFound === false) { return; }
								
								var ch = {
									type   : channel.type,
									channel: channels[j].channel,
									name   : a['display-name']['#'],
									id     : a['@'].id,
									sid    : a['service_id']
								};
								
								ch.programs = convertPrograms(result.programme, JSON.parse(JSON.stringify(ch)));
								
								schedule.push(ch);
								
								util.log(
									'CHANNEL: ' + ch.type + '-' + ch.channel + ' ... ' +
									ch.id + ' (sid=' + ch.sid + ') ' +
									'(programs=' + ch.programs.length.toString(10) + ')' +
									' - ' + ch.name
								);
							});
							break;
						default:
							// todo
					}//<-- switch
					
					turn();
				});
			});
			util.log('EXEC: ' + config.epgdumpPath + ' (pid=' + epgdumpProc.pid + ')');
		});//<-- recProc.on(exit, ...)
	})();//<-- _loop()
}//<-- getEpg()

// scheduler
function scheduler() {
	util.log('RUNNING SCHEDULER.');
	
	var typeNum = {};
	
	config.tuners.forEach(function(tuner) {
		tuner.types.forEach(function(type) {
			if (typeof typeNum[type] === 'undefined') {
				typeNum[type] = 1;
			} else {
				typeNum[type]++;
			}
		});
	});
	
	// matching
	var matches = [];
	
	schedule.forEach(function(ch) {
		ch.programs.forEach(function(p) {
			if (isMatchedProgram(p)) {
				matches.push(p);
			}
		});
	});
	
	reserves.forEach(function(reserve) {
		if (reserve.isManualReserve) matches.push(reserve);
	});
	
	util.log('MATCHES: ' + matches.length.toString(10));
	
	// check conflict
	var conflictCount = 0;
	for (var i = 0; i < matches.length; i++) {
		var a = matches[i];
		
		var tik = typeNum[a.channel.type];
		
		for (var j = 0; j < matches.length; j++) {
			var b = matches[j];
			
			if (b.isConflict) continue;
			
			if (a.id === b.id) continue;
			
			if (a.end <= b.start) continue;
			
			if (a.start >= b.end) continue;
			
			if (a.channel.type !== b.channel.type) continue;
			
			if (tik > 1) {
				tik--;
				continue;
			}
			
			util.log('CONFLICT: ' + dateFormat(new Date(a.start), 'isoDateTime') + ' [' + a.id + '] ' + a.title);
			a.isConflict = true;
			
			++conflictCount;
		}
	}
	
	util.log('CONFLICTS: ' + conflictCount.toString(10));
	
	// sort
	matches.sort(function(a, b) {
		return a.start - b.start;
	});
	
	// reserve
	reserves = [];
	var reservedCount = 0;
	for (var i = 0; i < matches.length; i++) {
		(function() {
			var a = matches[i];
			
			if (!a.isConflict) {
				reserves.push(a);
				util.log('RESERVE: ' + dateFormat(new Date(a.start), 'isoDateTime') + ' [' + a.id + '] ' + a.title);
				++reservedCount;
			}
		})();
	}
	
	util.log('RESERVES: ' + reservedCount.toString(10));
	
	if (!opts.get('s')) {
		outputReserves();
	}
}

// (function) program converter
function convertPrograms(p, ch) {
	var programs = [];
	
	for (var i = 0; i < p.length; i++) {
		var c = p[i];
		
		if (
			(c['@'].channel !== ch.id) ||
			(!c.title['#'])
		) {
			continue;
		}
		
		var tcRegex   = /^(.{4})(.{2})(.{2})(.{2})(.{2})(.{2}).+$/;
		var startDate = new Date( c['@'].start.replace(tcRegex, '$1/$2/$3 $4:$5:$6') );
		var endDate   = new Date( c['@'].stop.replace(tcRegex, '$1/$2/$3 $4:$5:$6') );
		var startTime = startDate.getTime();
		var endTime   = endDate.getTime();
		
		var flags = c.title['#'].match(/【(.)】/g);
		if (flags === null) {
			flags = [];
		} else {
			for (var j = 0; j < flags.length; j++) {
				flags[j] = flags[j].match(/【(.)】/)[1];
			}
		}
		
		var programData = {
			id        : ch.id.toLowerCase().replace('_', '') + '-' + (startTime / 1000).toString(32),
			channel   : ch,
			category  : c.category[1]['#'],
			title     : c.title['#'],
			detail    : c.desc['#'],
			start     : startTime,
			end       : endTime,
			seconds   : ((endTime - startTime) / 1000),
			flags     : flags
		};
		
		programs.push(programData);
	}
	
	return programs;
}

// (function) rule checker
function isMatchedProgram(program) {
	var result = false;
	
	rules.forEach(function(rule) {
		
		// sid
		if (rule.sid && rule.sid !== program.channel.sid) return;
		
		// types
		if (rule.types) {
			if (rule.types.indexOf(program.channel.type) === -1) return;
		}
		
		// channels
		if (rule.channels) {
			if (rule.channels.indexOf(program.channel.channel) === -1) return;
		}
		
		// ignore_channels
		if (rule.ignore_channels) {
			if (rule.ignore_channels.indexOf(program.channel.channel) !== -1) return;
		}
		
		// category
		if (rule.category && rule.category !== program.category) return;
		
		// categories
		if (rule.categories) {
			if (rule.categories.indexOf(program.category) === -1) return;
		}
		
		// hour
		if (rule.hour && rule.hour.start && rule.hour.end) {
			var ruleStart = rule.hour.start;
			var ruleEnd   = rule.hour.end;
			
			var progStart = new Date(program.start).getHours();
			var progEnd   = new Date(program.end).getHours();
			
			if ((ruleStart > progStart) && (ruleEnd < progEnd)) return;
		}
		
		// duration
		if (rule.duration && rule.duration.min && rule.duration.max) {
			if ((rule.duration.min > program.seconds) && (rule.duration.max < program.seconds)) return;
		}
		
		// ignore_titles
		if (rule.ignore_titles) {
			for (var i = 0; i < rule.ignore_titles.length; i++) {
				if (program.title.match(rule.ignore_titles[i]) !== null) return;
			}
		}
		
		// reserve_titles
		if (rule.reserve_titles) {
			var isFound = false;
			
			for (var i = 0; i < rule.reserve_titles.length; i++) {
				if (program.title.match(rule.reserve_titles[i]) !== null) isFound = true;
			}
			
			if (!isFound) return;
		}
		
		// ignore_flags
		if (rule.ignore_flags) {
			for (var i = 0; i < rule.ignore_flags.length; i++) {
				for (var j = 0; j < program.flags.length; j++) {
					if (rule.ignore_flags[i] === program.flags[j]) return;
				}
			}
		}
		
		result = true;
		
	});
	
	return result;
}

// (function) remake reserves
function outputReserves() {
	util.log('WRITE: ' + RESERVES_DATA_FILE);
	
	var array = [];
	
	reserves.forEach(function(reserve) {
		if (reserve.end < new Date().getTime()) return;
		
		array.push(reserve);
	});
	
	fs.writeFileSync( RESERVES_DATA_FILE, JSON.stringify(array, null, '  ') );
}
