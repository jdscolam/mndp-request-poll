'use strict';

console.log('Loading function...');
console.log('Loading dependencies...');
const _ = require('lodash');
const axios = require('axios');
const admin = require("firebase-admin");

const NOW_PLAYING = 'nowplaying';
const TAG_NAME = 'mondaynightdanceparty';
const SOURCE = 'poller';

// noinspection JSUnusedLocalSymbols
exports.handler = (event, context) => {
    console.log('Configuring Firebase...');
    let app = admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.project_id,
            clientEmail: process.env.client_email,
            privateKey: JSON.parse(process.env.firebase_token)
        }),
        databaseURL: process.env.database_url
    });

    //Get a database reference.
    let fb = admin.database();

    updateRequests(fb)
        .then(x => app.delete())
        .catch(error => {
            console.log(error);
            return app.delete();
        });
};

function updateRequests(fb){
    let metaRef = fb.ref('shows/meta/mondaynightdanceparty');
    let requestRef = fb.ref('shows/requests/mondaynightdanceparty');

    return getLastPostId(metaRef)
        .then(x => processLastPostId(x, metaRef))
        .then(x => processLatestRequestPosts(x, metaRef, requestRef));
}

function getLastPostId(metaRef){
    return metaRef.once('value');
}

function processLastPostId(snapshot, metaRef){
    let result = snapshot.val();
    let lastRequestPostId = 0;

    if(!result || !result.lastRequestPostId || !_.isFinite(result.lastRequestPostId))
        updateLastRequestPostId(metaRef, lastRequestPostId);
    else
        lastRequestPostId = result.lastRequestPostId;

    return getLatestRequestPosts(lastRequestPostId);
}

function updateLastRequestPostId(metaRef, newPostId){
    metaRef.update({
        "lastRequestPostId": newPostId
    });
}

function getLatestRequestPosts(lastRequestPostId){
    console.log('Configuring Pnut service...');
    let pnutApi = axios.create({
        baseURL: 'https://api.pnut.io'
    });

    pnutApi.defaults.headers.common['Authorization'] = process.env.pnut_token;

    console.log('Loading requests from Pnut...');
    return pnutApi.get('/v0/posts/tag/' + TAG_NAME, {
        params: {
            since_id: lastRequestPostId
            , count: 100
        }
    });
}

function processLatestRequestPosts(response, metaRef, requestRef){
    if(!response.data.data || response.data.data.length === 0){
        console.log('No new requests to process, exiting...');
        return;
    }

    let processedRequests = processRequests(response.data.data);
    updateLastRequestPostId(metaRef, processedRequests.maxPostId);

    if(processedRequests.validRequests.length <= 0)
    {
        console.log('No valid requests found, exiting.');
        return;
    }

    return buildRequestQueue(processedRequests.validRequests, requestRef, getYouTubeApi());
}

function processRequests(posts){
    console.log('Processing requests...');

    return _.transform(posts, processPost, {
        maxPostId: 0
        , validRequests: []
    });
}

function processPost(processedRequests, post){
    if(_.toSafeInteger(post.id) > processedRequests.maxPostId)
        processedRequests.maxPostId = _.toSafeInteger(post.id);

    if(isValidRequest(post))
        processedRequests.validRequests.push(post);
}

function isValidRequest(post){
    post.queueKey = TAG_NAME;

    // noinspection JSUnresolvedVariable
    return post.content
        && post.content.entities
        && post.content.entities.links
        && post.content.entities.links.length !== 0
        && post.content.entities.tags
        && !isNowPlayingPost(post)
        && hasValidRequestLink(post);
}

function isNowPlayingPost(post){
    // noinspection JSUnresolvedVariable
    return _.some(post.content.entities.tags, tag => _.toLower(tag.text) === NOW_PLAYING);
}

function hasValidRequestLink(post){
    return _.some(post.content.entities.links, link =>{
        let linkDetails = getEmbeddedLink(link.link);

        if(!linkDetails)
            return false;

        post.linkDetails = linkDetails;
        return true;
    });
}

function getEmbeddedLink(url){
    //Validate for YouTube link.
    let regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=|\?v=)([^#&?]*).*/;
    let match = url.match(regExp);
    if (match && match[2].length === 11) {
        return {
            id: match[2],
            embeddedLink: 'https://www.youtube.com/embed/' + match[2] + '?autoplay=1&enablejsapi=1'
        };
    }
    else {
        return '';
    }
}

function buildRequestQueue(validRequests, requestRef, youTubeApi){
    console.log('Building queue from ' + validRequests.length + ' valid requests...');

    return Promise.all(_.map(validRequests, requestPost => {
        return getYouTubeVideoDetails(youTubeApi, requestPost)
            .then(response => {
                if(!response || !response.data || !response.data.items || response.data.items.length === 0)
                    return null;

                // noinspection JSUnresolvedVariable
                let request = generateRequest(requestPost, response.data.items[0].snippet.title);

                return requestRef.push(request);
            });
    })).then(() =>{
        console.log('Queue saved, exiting...');
    });
}

function getYouTubeApi(){
    console.log('Configuring YouTube API');
    let youTubeApi = axios.create({
        baseURL: 'https://www.googleapis.com'
    });

    //NOTE:  Have to delete the "Auth" header here or Google flips out that it's a bad token because it's seeing the Pnut token.
    delete youTubeApi.defaults.headers.common['Authorization'];

    return youTubeApi;
}

function getYouTubeVideoDetails(youTubeApi, requestPost){

    return youTubeApi.get('/youtube/v3/videos', {
        params: {
            id: requestPost.linkDetails.id
            , part: 'snippet'
            , key: process.env.youtube_key
        }
    });
}

function generateRequest(requestPost, title){
    let request = {
        postId: requestPost.id,
        videoEmbedLink: requestPost.linkDetails.embeddedLink,
        videoId: requestPost.linkDetails.id,
        title: title,
        source: SOURCE
    };

    if(requestPost.user)
    {
        request.user = requestPost.user.username;
        request.userId = requestPost.user.id;
        request.avatarLink = requestPost.user.content.avatar_image && requestPost.user.content.avatar_image.link
            ? requestPost.user.content.avatar_image.link
            : '';
    }

    return request;
}
