"use strict";

/*jshint esversion: 6 */
/*jslint node: true */
import express    from 'express';
import path       from 'path';
import logger     from 'morgan';
import bodyParser from 'body-parser';
import favicon from 'serve-favicon';
import swig from 'swig';
import React from 'react';
import Router from 'react-router';
import Waterline from 'waterline';
import async from 'async';
import request from 'request';
import xml2js from 'xml2js';
import _ from 'lodash';

import routes from './app/routes';
import Config from './config';
import Character from './models/character';

let app = express();
let orm = new Waterline();
orm.loadCollection(Character);

app.set('port',process.env.PORT || 3000);
app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(favicon(path.join(__dirname,'public','favicon.png')));
app.use(express.static(path.join(__dirname,'public')));

app.put('/api/characters/', (req, res, next) => {
	let winner = req.body.winner;
	let loser = req.body.loser;

	console.log('winner: ' + winner + '\n');
	console.log('loser: ' + loser +'\n');
	if(!winner || !loser) {
		return res.status(400).send({ message: 'Voting requires two characters.'});
	}

	if(winner === loser) {
		return res.status(400).send({ message: 'Cannot vote for and against the same characters'});
	}

	async.parallel([
		callback => {
			app.models.character.findOne({ characterId: winner }, (err, winner) => {
				callback(err,winner);
			});
		},
		callback => {
			app.models.character.findOne({ characterId: loser}, (err, winner) => {
				callback(err,winner);
			});
		}		
	],
	(err, results) => {
		if(err) return next(err);

		let winner = results[0];
		let loser = results[1];

		if(!winner || !loser) {
			return res.status(404).send({ message: 'One of the characters no longer exists.'});
		}

		if(winner.voted || loser.voted){
			return res.status(200).end();
		}

		async.parallel([
			callback => {
				winner.wins++;
				winner.voted = true
				winner.save(err => {
					callback(err);
				});
			},
			callback => {
				loser.losses++;
				loser.voted = true;
				loser.save(err => {
					callback(err);
				});
			}
		],err => {
			if(err) return next(err);
			res.status(200).end();
		});
	});
});


app.get('/api/characters', (req,res,next) => {
	let choice = ['Female', 'Male'];
	let randomGender = _.sample(choice);
	//原文中是通过nearby字段来实现随机取值，waterline没有实现mysql order by rand(),所以返回所有结果，用lodash来处理
	app.models.character.find()
		.where({'voted': false})
		.exec((err,characters) => {
			if(err) return next(err);
			//当返回的结果大于2的时候，直接返回结果
			if(characters.length >=2){
				//用lodash来取两个随机值
				let randomCharacters = _.sampleSize(_.filter(characters,{'gender': randomGender}),2); 
				//console.log(randomCharacters);
				return res.send(randomCharacters);
			}

			//换个性别再试试
			let oppsiteGender = _.first(_.without(choice, randomGender));
			let oppsiteCharacters = _.sampleSize(_.filter(characters,{'gender': oppsiteGender}),2); 

			if(oppsiteCharacters === 2) {
				return res.send(oppsiteCharacters);
			}

			//更新所有角色这步先不做了
			return res.send([]);


		});

});

app.post('/api/characters',(req,res,next) => {
	let gender = req.body.gender;
	let characterName = req.body.name;
	let characterIdLookupUrl = 'https://api.eveonline.com/eve/CharacterId.xml.aspx?names=' + characterName;

	const parser = new xml2js.Parser();

	async.waterfall([
		function(callback) {
			request.get(characterIdLookupUrl,(err,request,xml) => {
				if(err) return next(err);
				parser.parseString(xml,(err,parsedXml) => {
					try {
						let characterId = parsedXml.eveapi.result[0].rowset[0].row[0].$.characterID;

						app.models.character.findOne({ characterId: characterId},(err,model) => {
							if(err) return next(err);

							if(model) {
								return res.status(400).send({ message: model.name + ' is alread in the database'});
							}

							callback(err,characterId);
						});
					} catch(e) {
						return res.status(400).send({ message: ' xml Parse Error'});
					}
				});
			});
		},
		function(characterId) {
			let characterInfoUrl = 'https://api.eveonline.com/eve/CharacterInfo.xml.aspx?characterID=' + characterId;
			console.log(characterInfoUrl);
			request.get({ url: characterInfoUrl },(err,request,xml) => {
				if(err) return next(err);
				parser.parseString(xml, (err,parsedXml) => {
					if (err) return res.send(err);
					try{
						let name = parsedXml.eveapi.result[0].characterName[0];
						let race = parsedXml.eveapi.result[0].race[0];
						let bloodline = parsedXml.eveapi.result[0].bloodline[0];
						app.models.character.create({
							characterId: characterId,
							name: name,
							race: race,
							bloodline: bloodline,
							gender: gender
						},(err,model) => {
							if(err) return next(err);
							res.send({ message: characterName + ' has been added successfully!'});
						});
					} catch (e) {
						res.status(404).send({ message: characterName + ' is not a registered citizen of New Eden',error: e.message });
					}
				});
			});
		}
	]);
});


app.use((req,res) => {
	Router.run(routes,req.path, (Handler) => {
		var html = React.renderToString(React.createElement(Handler));
		var page = swig.renderFile('views/index.html', { html: html});
		res.send(page);
	});
});


const server =require('http').createServer(app);
const io = require('socket.io')(server);
let onlineUsers = 0;

io.sockets.on('connection', (socket) => {
	onlineUsers++;
	console.log('curonlieUsers: ' + onlineUsers);
	io.sockets.emit('onlineUsers',{ onlineUsers: onlineUsers });

	socket.on('disconnect', () => {
		onlineUsers--;
		io.sockets.emit('onlineUsers', { onlineUsers: onlineUsers });
	});
});



orm.initialize(Config,function(err,models){
	if(err) throw err;
	app.models = models.collections;
	//app.set('models',models.collections);
	app.connections = models.connections;

	server.listen(app.get('port'),() => {
		console.log('Express server listening on port ' + app.get('port'));
	});
});