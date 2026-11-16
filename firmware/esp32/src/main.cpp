#include <Arduino.h>

#include "config.h"
#include "classic_bt_controller_transport.h"
#include "controller.h"
#include "protocol.h"

#if USE_MOCK_CONTROLLER
#include "mock_controller_transport.h"
#endif

namespace {

struct SequencedFrame {
  String sessionId;
  uint32_t sequence = 0;
  String command;
};

struct SequencedCommandCache {
  bool hasSession = false;
  String sessionId;
  uint32_t lastSequence = 0;
  String lastCommand;
  String lastAckLine;
};

#if USE_MOCK_CONTROLLER
MockControllerTransport mockTransport;
ControllerTransport &transport = mockTransport;
#else
ClassicBtControllerTransport classicBtTransport;
ControllerTransport &transport = classicBtTransport;
#endif

SwitchController controller(transport);
SequencedCommandCache sequencedCommandCache;

bool isHexSessionId(const String &value) {
  if (value.length() != 8) {
    return false;
  }

  for (size_t index = 0; index < value.length(); index += 1) {
    const char c = value.charAt(index);
    const bool isHex =
        (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

    if (!isHex) {
      return false;
    }
  }

  return true;
}

bool parseSequenceToken(const String &value, uint32_t &sequence) {
  if (value.length() == 0) {
    return false;
  }

  uint32_t parsed = 0;

  for (size_t index = 0; index < value.length(); index += 1) {
    const char c = value.charAt(index);

    if (c < '0' || c > '9') {
      return false;
    }

    const uint32_t digit = static_cast<uint32_t>(c - '0');

    if (parsed > (UINT32_MAX - digit) / 10) {
      return false;
    }

    parsed = parsed * 10 + digit;
  }

  if (parsed == 0) {
    return false;
  }

  sequence = parsed;
  return true;
}

bool parseSequencedFrame(const String &line, SequencedFrame &frame) {
  if (!line.startsWith("SEQ ")) {
    return false;
  }

  const int firstSpace = line.indexOf(' ');
  const int secondSpace = line.indexOf(' ', firstSpace + 1);
  const int thirdSpace = line.indexOf(' ', secondSpace + 1);

  if (secondSpace < 0 || thirdSpace < 0) {
    return false;
  }

  String sessionId = line.substring(firstSpace + 1, secondSpace);
  String sequenceToken = line.substring(secondSpace + 1, thirdSpace);
  String command = line.substring(thirdSpace + 1);
  command.trim();

  if (!isHexSessionId(sessionId) || command.length() == 0) {
    return false;
  }

  uint32_t sequence = 0;

  if (!parseSequenceToken(sequenceToken, sequence)) {
    return false;
  }

  sessionId.toLowerCase();
  frame.sessionId = sessionId;
  frame.sequence = sequence;
  frame.command = command;
  return true;
}

String makeOkAck(const SequencedFrame &frame) {
  return "OK " + frame.sessionId + " " + String(frame.sequence);
}

String makeErrorAck(const SequencedFrame &frame, const String &message) {
  return "ERR " + frame.sessionId + " " + String(frame.sequence) + " " + message;
}

bool validateSequencedFrame(const SequencedFrame &frame, String &ackLine) {
  if (!sequencedCommandCache.hasSession || sequencedCommandCache.sessionId != frame.sessionId) {
    if (frame.sequence != 1) {
      ackLine = makeErrorAck(frame, "sequence expected 1 for new session");
      return false;
    }

    sequencedCommandCache.hasSession = true;
    sequencedCommandCache.sessionId = frame.sessionId;
    sequencedCommandCache.lastSequence = 0;
    sequencedCommandCache.lastCommand = "";
    sequencedCommandCache.lastAckLine = "";
    return true;
  }

  if (frame.sequence == sequencedCommandCache.lastSequence) {
    if (frame.command == sequencedCommandCache.lastCommand &&
        sequencedCommandCache.lastAckLine.length() > 0) {
      ackLine = sequencedCommandCache.lastAckLine;
      return false;
    }

    ackLine = makeErrorAck(frame, "duplicate sequence command mismatch");
    return false;
  }

  if (frame.sequence != sequencedCommandCache.lastSequence + 1) {
    ackLine = makeErrorAck(
        frame, "sequence expected " + String(sequencedCommandCache.lastSequence + 1));
    return false;
  }

  return true;
}

void cacheSequencedResult(const SequencedFrame &frame, const String &ackLine) {
  sequencedCommandCache.lastSequence = frame.sequence;
  sequencedCommandCache.lastCommand = frame.command;
  sequencedCommandCache.lastAckLine = ackLine;
}

}  // namespace

void setup() {
  // 默认 TX ring buffer 仅 256B：演奏时每击都有进度行/PROBE 行（探针版
  // ~146B/击），printf 写入偶发背压会在两击之间阻塞最多 ~11ms，且每击
  // 确定性叠加，整曲累积可达数百毫秒（听起来就是均匀地变慢、对不上伴奏）。
  // 2048B 可容下十几击的输出，而一个 258ms 间隔内 UART 能排空 3KB，稳态
  // 永不背压。必须在 begin() 之前设置。
  Serial.setTxBufferSize(2048);
  Serial.begin(SERIAL_BAUD_RATE);
  controller.begin();
  Serial.printf(
      "BOOT %s board=%s transport=%s mock=%s\n",
      FIRMWARE_NAME,
      BOARD_FAMILY,
      controller.transportName(),
      USE_MOCK_CONTROLLER ? "true" : "false");
}

void loop() {
  if (!Serial.available()) {
    delay(2);
    return;
  }

  String line = Serial.readStringUntil('\n');
  line.trim();

  if (line.length() == 0) {
    return;
  }

  SequencedFrame frame;

  if (!parseSequencedFrame(line, frame)) {
    Serial.printf("ECHO raw command=\"%s\"\n", line.c_str());

    // pio device monitor is commonly used to type one-off commands by hand while
    // debugging BT pairing/input behavior. Those manual lines are not wrapped in
    // the SEQ protocol format used by the UI transport.
    // Keep this raw fallback so monitor-driven bring-up and recovery checks work
    // without requiring a host session ID/sequence generator.
    String error;
    const bool ok = executeCommand(line, controller, error);

    if (ok) {
      Serial.println("OK");
    } else {
      const bool allowNoBtDryRun = error == "controller input report failed";

      if (allowNoBtDryRun) {
        // In monitor-only testing, transport can be disconnected; still report a
        // successful command parse/execution path so command logic can be tested.
        Serial.println("OK dry-run no-bt");
      } else {
        Serial.println("ERR " + (error.length() > 0 ? error : "unknown error"));
      }
    }
    return;
  }

  // 注意：长序列分片单行可达 700+ 字节。若在此处回显整条 command，UART
  // 发送环形缓冲（256B）填满后会阻塞约 40ms，且这段阻塞发生在命令执行前，
  // 会与下一条命令的下行字节传输（115200 下约 60ms）叠加成跨分片接缝卡顿。
  // 上位机不消费 ECHO 行，因此 SEQ 帧只回显序号和命令长度做调试锚点。
  Serial.printf(
      "ECHO seq session=%s sequence=%lu len=%u\n",
      frame.sessionId.c_str(),
      static_cast<unsigned long>(frame.sequence),
      static_cast<unsigned>(frame.command.length()));

  String ackLine;

  if (!validateSequencedFrame(frame, ackLine)) {
    Serial.println(ackLine);
    return;
  }

  String error;
  const bool ok = executeCommand(frame.command, controller, error);

  if (ok) {
    ackLine = makeOkAck(frame);
    cacheSequencedResult(frame, ackLine);
    Serial.println(ackLine);
    return;
  }

  ackLine = makeErrorAck(frame, error.length() > 0 ? error : "unknown error");
  cacheSequencedResult(frame, ackLine);
  Serial.println(ackLine);
}
