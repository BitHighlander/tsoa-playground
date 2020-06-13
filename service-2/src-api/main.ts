require('dotenv').config()
require('dotenv').config({path:"./.env"})
require('dotenv').config({path:"./../.env"})
require('dotenv').config({path:"./../../.env"})
require('dotenv').config({path:"../../../.env"})
require('dotenv').config({path:"../../../../.env"})
require('dotenv').config({path:"./../../../../.env"})

const pjson = require('../package.json');
const TAG = " | "+ pjson.name +" | "
const log = require('@bithighlander/loggerdog-client')()
const {subscriber, publisher, redis} = require('@bithighlander/default-redis')
const cors = require('cors')
import * as bodyParser from 'body-parser';
import * as express from 'express';
import * as methodOverride from 'method-override';

import { RegisterRoutes } from './routes/routes';  // here
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('../api/dist/swagger.json')

//Rate limiter options
//https://github.com/animir/node-rate-limiter-flexible/wiki/Overall-example#create-simple-rate-limiter-and-consume-points-on-entry-point
const { RateLimiterRedis } = require('rate-limiter-flexible');

const app = express();
const server = require('http').Server(app);
let API_PORT = parseInt(process.env["API_PORT_PIONEER"]) || 4001
let RATE_LIMIT_RPM = parseInt(process.env["RATE_LIMIT_TPS"]) || 5

//limiter
const rateLimiterRedis = new RateLimiterRedis({
    storeClient: redis,
    points: RATE_LIMIT_RPM, // Number of points
    duration: 1, // Per second
});

const WHITELIST_CACHE = []
const rateLimiterMiddleware = async (req, res, next) => {
    try{
        if(req.headers.authorization){
            let auth = req.headers.authorization
            log.info('path: ',req.url)
            let path = req.path
            if(auth.indexOf('Bearer ')) auth.replace('Bearer ','')

            //if in cache
            if(WHITELIST_CACHE.indexOf(auth)){
                next();
            } else {
                let isWhitelisted = await redis.sismember("PIONEER_WHITELIST_KEYS",auth)
                if(isWhitelisted){
                    WHITELIST_CACHE.push(auth)
                    next();
                } else {
                    rateLimiterRedis.consume(req.ip)
                        .then(() => {
                            next();
                        })
                        .catch(_ => {
                            res.status(429).send('Too Many Requests');
                        });
                }
            }
        } else {
            rateLimiterRedis.consume(req.ip)
                .then(() => {
                    next();
                })
                .catch(_ => {
                    res.status(429).send('Too Many Requests');
                });
        }
    }catch(e){
        console.error(e)
    }
};

var corsOptions = {
    origin: function (origin, callback) {
        if (true) {
            callback(null, true)
        } else {
            callback(new Error('Not allowed by CORS'))
        }
    }
}


app.use(cors(corsOptions))
app.use(rateLimiterMiddleware);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(methodOverride());

//socket
let SOCKET_MAX_CONNECTIONS = parseInt(process.env["SOCKET_MAX_CONNECTIONS"]) || 20

//socket-io
let io = require('socket.io')(server);
io.sockets.setMaxListeners(SOCKET_MAX_CONNECTIONS);

//web
app.use('/',express.static('dist/spa'));

//docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

//swagger.json
app.use('/spec', express.static('api/dist'));


//REST API v1
RegisterRoutes(app);  // and here

//redis-bridge
subscriber.subscribe('pioneer-events');
subscriber.subscribe('payments');
subscriber.subscribe('pioneer:transactions:all');

subscriber.on('message', async function (channel, payloadS) {
    let tag = TAG + ' | publishToFront | ';
    try {
        log.debug(tag,"event: ",payloadS)
        //Push event over socket
        if(channel === 'payments'){
            let payload = JSON.parse(payloadS)
            payload.event = 'transaction'
            payloadS = JSON.stringify(payload)
        }

        //legacy hack
        if(channel === 'payments') channel = 'events'

        //
        io.emit(channel, payloadS);

    } catch (e) {
        log.error(tag, e);
        throw e
    }
});


//Error handeling
function errorHandler (err, req, res, next) {
    if (res.headersSent) {
        return next(err)
    }
    log.error("ERROR: ",err)
    res.status(400).send({
        message: err.message,
        error: err
    });
}
app.use(errorHandler)

server.listen(API_PORT, () => console.log(`Server started listening to port ${API_PORT}`));
