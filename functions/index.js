
const { WebClient } = require('@slack/web-api');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { createEventAdapter } = require('@slack/events-api');

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const firestore = new Firestore();
admin.initializeApp();
const projectId = admin.instanceId().app.options.projectId;
const isDev = projectId != "product-kintore";
const slackEvents = createEventAdapter(isDev ? process.env.DEV_SLACK_SIGNING_SECRET : process.env.SLACK_SIGNING_SECRET);

const urlPattern = /<(https?:\/\/[^\s]+)>/g;
const fetchPageTitle = async (url) => {
  try {
    const response = await axios.get(url, { timeout : 10000 });
    const $ = cheerio.load(response.data);
    return $('title').text();
  } catch (error) {
    console.error(`Error fetching title for URL: ${url}`, error);
    return null;
  }
};

slackEvents.on('team_join', async (event) => {
  const webClient = new WebClient(isDev ? process.env.DEV_SLACK_BOT_TOKEN : process.env.SLACK_BOT_TOKEN);
  try {
    await webClient.chat.postMessage({
      channel: event.user.id,
      text: ":tada: プロダクト筋トレへようこそ\nここは「プロダクトづくりに関する知識を広げ、深め、身につける」を目的に、「他者から学び合う」コミュニティです。\nぜひ、みなさんで知見の交換をして良いプロダクトをつくっていきましょう！\n\n:eyes: どんな人がいるの？ // TBD: URLを貼る \n:eyes: まず何をすればいいの？ #0_自己紹介 に自己紹介を投稿してみてください！ // TBD: 新しいフローを案内したいのでURLをはる\n:eyes: 困った時は？\n #投書箱 か #2_雑談 もしくは <@D01GCTQH0AW>に 声をかけてください！",
    });

    const response = await webClient.users.info({
      user: event.user.id,
    });

    const timestamp = FieldValue.serverTimestamp();
    await firestore.collection('users').doc(event.user.id).set({
      id: event.user.id,
      name: event.user.name,
      email: response.user.profile.email,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
  catch (error) {
    console.error(error);
  }
});

slackEvents.on('message', async (event) => {
  console.log(event);

  const channelId = event.channel;
  if (channelId == "C0336LF8HEG" || channelId == "C01FY636KD5") await iikijiRecorder(event); // #bot-test or #1_いい記事系
  // if (channelId == "C01FY636KD5") await iikijiRecorder(event); // #bot-test or #1_いい記事系
  // if (channelId == "C0336LF8HEG" || channelId == "C01H2PN9ETA") await moyamoyaRecorder(event); // #bot-test or #3_モヤモヤ
  if (channelId == "C01H2PN9ETA") await moyamoyaRecorder(event); // #3_モヤモヤ
});

async function iikijiRecorder(event) {
  if (event.thread_ts != undefined) {
    console.log("スレッド");
    const threadRef = firestore.collection('article_thread_replies').doc(event.thread_ts);
    try {
      await threadRef.set({
        user: event.user,
        text: event.text,
        ts: event.ts,
      });
    } catch (err) {
      console.log(`Error: ${JSON.stringify(err)}`)
    } 
    return;
  }

  const text = String(event.text);
  const urls = text.match(urlPattern);

  if (!urls) {
    console.log("URL含まれてない");
    return; 
  }

  const url = extractContent(urls[0]);
  const pageTitle = await fetchPageTitle(url);

  var notionEndpoint = 'https://api.notion.com/v1/pages';
  var notion_token = 'secret_G2WfIJxYjdQqui6kRWqz9AhEfkELojwTFOEMb9wywhE';
  var database_id = 'e05f4508812f4648963ad6934f6be159';
  var headers = {
    'Content-Type' : 'application/json',
    'Authorization': 'Bearer ' + notion_token,
    'Notion-Version': '2022-06-28',
  };

  var post_data = {
    'parent': {'database_id': database_id},
    'properties': {
      "title": {
          "title": [
              {
                  "type": "text",
                  "text": {
                      "content": pageTitle
                  }
              }
          ]
      },
      "link": {
          "url": url
      },
      "slackMessageUrl": {
          "url":  `https://product-kintore.slack.com/archives/${event.channel}/p${event.ts.replace('.', '')}`,
      },
      "Property": {
          "rich_text": [
              {
                  "text": {
                      "content": text
                  }
              }
          ]
      },
    },
  };

  await axios.post(notionEndpoint, post_data, {headers: headers});  

  const messagesRef = firestore.collection('articles');
  const messageData = {
    url: url,
    title: pageTitle,
    message: text,
    ts: event.ts,
    slackMessageUrl: `https://product-kintore.slack.com/archives/${event.channel}/p${event.ts.replace('.', '')}`,
  };
  await messagesRef.add(messageData);
}

async function moyamoyaRecorder(event) {
  const { text, ts, user, thread_ts, permalink } = event;
  const createdAt = new Date(parseFloat(ts) * 1000);

  if (event.thread_ts != undefined) {
    console.log("スレッド");
    // スレッドでの返信の場合、親スレッドのcommentに追加する
    const parentDocRef = firestore.collection('moyamoya').doc(thread_ts);
    const parentDoc = await parentDocRef.get();
    if (parentDoc.exists) {
      const parentData = parentDoc.data();
      const newComment = {
        comment: text,
        commented: user,
        createdAt: createdAt.toString(),
      };
      let comments = parentData.comments || [];
      comments.push(newComment);
      await parentDocRef.update({ comments });
    } else {
      console.log("親なし子");
    }
    return;
  }

  const title = text.substring(0, 20);
  const data = {
    moyamoya: text,
    createdAt: createdAt,
    moyamoyaUser: user,
    title: title,
    ts: ts,
    slackMessageUrl: `https://product-kintore.slack.com/archives/${event.channel}/p${ts.replace('.', '')}`,
  };
  console.log(data)
  await firestore.collection('moyamoya').doc(ts).set(data);
}

function extractContent(tag) {
  const regex = /<([^>]+)>/;
  const match = tag.match(regex);
  return match ? match[1] : null;
}

exports.slackApp = functions.region('asia-northeast1').https.onRequest(async (req, res) => {
  console.log('Received a request');
  slackEvents.requestListener()(req, res);
});

exports.postNewComer = functions.region('asia-northeast1').https.onRequest(async (req, res) => {
  let text = "今週、新しく参加してくださった方を紹介します:tada::tada:あたたかくお迎えしましょう:muscle: \n";
  text += "--------------\n";

  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  try {
    const snapshot = await firestore.collection('users')
      .where('created_at', '>', oneWeekAgo)
      .get();

    if (snapshot.empty) {
      console.log('今週の参加者はいなかったよ');
      return;
    }  

    snapshot.forEach(doc => {
      const userData = doc.data();
      text += `<https://product-kintore.web.app/profile/${userData.profile}|${userData.name}さん><@${userData.id}>\n`; // TBD: urlは適当
      if(userData.company != undefined) text += `　　所属は${userData.company}\n`;
      if(userData.role!= undefined) text += `　　役割は${userData.role}\n`;
      if(userData.interested_activities != undefined) text += `興味がある活動は${userData.interested_activities.title}\n`;
    });
  } 
  catch (error) {
    console.error(error);
  }

  const webClient = new WebClient(isDev ? process.env.DEV_SLACK_BOT_TOKEN : process.env.SLACK_BOT_TOKEN);
  try {
    await webClient.chat.postMessage({
      channel: isDev ? "C05G11EHUP7" : "C01H2P2M8F2",
      text: text,
    });
  }
  catch (error) {
    console.error(error);
  }

  response.send("ok");
});

