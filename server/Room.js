const protoo = require("protoo-server");
const config = require("./config");

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
];

class Room {
  static async create({ mediasoupWorker, roomId }) {
    const protooRoom = new protoo.Room();
    // const { mediaCodecs } = config.mediasoup.routerOptions;
    const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });
    return new Room({
      roomId,
      protooRoom,
      mediasoupRouter,
    });
  }

  constructor({ roomId, protooRoom, mediasoupRouter }) {
    this._roomId = roomId;
    this._closed = false;
    this._protooRoom = protooRoom;
    this._mediasoupRouter = mediasoupRouter;
    this._producer = null;
  }

  handleProtooConnection({ peerId, consume, protooWebSocketTransport }) {
    const existingPeer = this._protooRoom.getPeer(peerId);

    if (existingPeer) {
      console.log("이미 존재하는 peer");
      existingPeer.close();
    }

    let peer;

    // 방에 peer 생성
    try {
      peer = this._protooRoom.createPeer(peerId, protooWebSocketTransport);
    } catch (error) {
      console.log(error.message);
    }

    peer.data.consume = consume;
    peer.data.joined = false;
    peer.data.rtpCapabilities = undefined;
    peer.data.sctpCapabilities = undefined;

    // 만들어진 peer에 이벤트 등록
    peer.on("request", (request, accept, reject) => {
      console.log(`protoo Peer request event ${request.method} ${peer.id}`);

      this._handleProtooRequest(peer, request, accept, reject).catch(
        (error) => {
          console.log(`request failed ${error}`);

          reject(error);
        }
      );
    });
  }

  getRouterRtpCapabilities() {
    return this._mediasoupRouter.rtpCapabilities;
  }

  createWebRtcTransport = async () => {
    try {
      const webRtcTransport_options = {
        listenIps: [
          {
            ip: "0.0.0.0", // replace with relevant IP address
            announcedIp: "127.0.0.1",
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      };

      let transport = await this._mediasoupRouter.createWebRtcTransport(
        webRtcTransport_options
      );

      transport.on("dtlsstatechange", (dtlsState) => {
        if (dtlsState === "closed") {
          transport.close();
        }
      });

      transport.on("close", () => {
        console.log("transport closed");
      });

      const info = {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      };

      return [transport, info];
    } catch (error) {
      console.log(error);
    }
  };

  async _handleProtooRequest(peer, request, accept, reject) {
    switch (request.method) {
      case "getRouterRtpCapabilities": {
        accept(this._mediasoupRouter.rtpCapabilities);
        break;
      }
      case "createWebRtcTransport": {
        // producer
        if (!peer.data.consume) {
          console.log("producer");
          const [transport, info] = await this.createWebRtcTransport();
          peer.data.produceTransport = transport;
          accept(info);
        } else {
          // consumer
          console.log("consumer");
          const [transport, info] = await this.createWebRtcTransport();
          peer.data.consumeTransport = transport;
          accept(info);
        }
        break;
      }
      case "produceConnect": {
        const { dtlsParameters } = request.data;
        if (peer.data?.produceTransport) {
          await peer.data.produceTransport.connect({ dtlsParameters });
          accept(dtlsParameters);
        }
        break;
      }
      case "produceProduce": {
        const { kind, rtpParameters, appData } = request.data;
        if (peer.data?.produceTransport) {
          peer.data.producer = await peer.data.produceTransport.produce({
            kind,
            rtpParameters,
          });
          this._producer = peer.data.producer;
          console.log(this._producer.id);
        }
        break;
      }
      case "connectConsume": {
        console.log("hi");
        const { dtlsParameters } = request.data;
        console.log(dtlsParameters);
        if (peer.data?.consumeTransport) {
          try {
            await peer.data.consumeTransport.connect({ dtlsParameters });
          } catch (error) {
            console.log(error.message);
          }
        }
        accept({ id: "test" });
        break;
      }
      case "consume": {
        const { rtpCapabilities } = request.data;
        console.log(this._producer.id);
        console.log(
          this._mediasoupRouter.canConsume({
            producerId: this._producer.id,
            rtpCapabilities,
          })
        );

        try {
          if (
            this._mediasoupRouter.canConsume({
              producerId: this._producer.id,
              rtpCapabilities,
            }) &&
            peer.data?.consumeTransport
          ) {
            peer.data.consumer = await peer.data.consumeTransport.consume({
              producerId: this._producer.id,
              rtpCapabilities,
              //   paused: true,
            });

            peer.data.consumer.on("transportclose", () => {
              console.log("transport close from consumer");
            });

            peer.data.consumer.on("producerclose", () => {
              console.log("producer of consumer closed");
            });

            accept({
              id: peer.data.consumer.id,
              producerId: this._producer.id,
              kind: peer.data.consumer.kind,
              rtpParameters: peer.data.consumer.rtpParameters,
            });
          }
        } catch (error) {
          console.log(error);
        }
        break;
      }
      case "consumerResume": {
        console.log("consumer resume");
        if (peer.data?.consumer) {
          await peer.data.consumer.resume();
        }
      }
    }
  }
}

module.exports = Room;
