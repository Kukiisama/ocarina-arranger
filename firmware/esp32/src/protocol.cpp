#include "protocol.h"

#include "config.h"

namespace {

ControllerButton parseButton(const String &line, bool &ok);

bool parseTwoInts(const String &value, int &first, int &second) {
  const int firstSpace = value.indexOf(' ');
  if (firstSpace < 0) {
    return false;
  }

  const int secondSpace = value.indexOf(' ', firstSpace + 1);
  if (secondSpace < 0) {
    return false;
  }

  first = value.substring(firstSpace + 1, secondSpace).toInt();
  second = value.substring(secondSpace + 1).toInt();
  return true;
}

bool parseLineCommand(const String &value, int &dx, int &dy, uint8_t &stride) {
  const int firstSpace = value.indexOf(' ');
  if (firstSpace < 0) {
    return false;
  }

  const int secondSpace = value.indexOf(' ', firstSpace + 1);
  if (secondSpace < 0) {
    return false;
  }

  const int thirdSpace = value.indexOf(' ', secondSpace + 1);

  if (thirdSpace < 0) {
    dx = value.substring(firstSpace + 1, secondSpace).toInt();
    dy = value.substring(secondSpace + 1).toInt();
    stride = 1;
    return true;
  }

  const int fourthSpace = value.indexOf(' ', thirdSpace + 1);
  if (fourthSpace >= 0) {
    return false;
  }

  dx = value.substring(firstSpace + 1, secondSpace).toInt();
  dy = value.substring(secondSpace + 1, thirdSpace).toInt();
  const int parsedStride = value.substring(thirdSpace + 1).toInt();

  if (parsedStride <= 0 || parsedStride > 255) {
    return false;
  }

  stride = static_cast<uint8_t>(parsedStride);
  return true;
}

bool parseThreeInts(const String &value, int &first, int &second, int &third) {
  const int firstSpace = value.indexOf(' ');
  if (firstSpace < 0) {
    return false;
  }

  const int secondSpace = value.indexOf(' ', firstSpace + 1);
  if (secondSpace < 0) {
    return false;
  }

  const int thirdSpace = value.indexOf(' ', secondSpace + 1);
  if (thirdSpace < 0) {
    return false;
  }

  first = value.substring(firstSpace + 1, secondSpace).toInt();
  second = value.substring(secondSpace + 1, thirdSpace).toInt();
  third = value.substring(thirdSpace + 1).toInt();
  return true;
}

bool parseOneInt(const String &value, int &result) {
  const int firstSpace = value.indexOf(' ');
  if (firstSpace < 0) {
    return false;
  }

  result = value.substring(firstSpace + 1).toInt();
  return true;
}

bool parseInputConfigCommand(
    const String &line, uint16_t &buttonPressMs, uint16_t &inputDelayMs, uint16_t &homeMs) {
  if (!line.startsWith("CFG INPUT ")) {
    return false;
  }

  const int firstSpace = line.indexOf(' ');
  const int secondSpace = line.indexOf(' ', firstSpace + 1);
  const int thirdSpace = line.indexOf(' ', secondSpace + 1);
  const int fourthSpace = line.indexOf(' ', thirdSpace + 1);

  if (secondSpace < 0 || thirdSpace < 0 || fourthSpace < 0) {
    return false;
  }

  const int buttonPress = line.substring(secondSpace + 1, thirdSpace).toInt();
  const int inputDelay = line.substring(thirdSpace + 1, fourthSpace).toInt();
  const int home = line.substring(fourthSpace + 1).toInt();

  if (buttonPress <= 0 || buttonPress > 60000 || inputDelay < 0 || inputDelay > 60000 ||
      home <= 0 || home > 60000) {
    return false;
  }

  buttonPressMs = static_cast<uint16_t>(buttonPress);
  inputDelayMs = static_cast<uint16_t>(inputDelay);
  homeMs = static_cast<uint16_t>(home);
  return true;
}

bool failControllerInput(String &error) {
  error = "controller input report failed";
  return false;
}

bool parseHexColorToken(const String &value, uint8_t &red, uint8_t &green, uint8_t &blue) {
  String token = value;
  token.trim();

  if (token.startsWith("#")) {
    token = token.substring(1);
  }

  if (token.length() != 6) {
    return false;
  }

  const long parsed = strtol(token.c_str(), nullptr, 16);
  red = static_cast<uint8_t>((parsed >> 16) & 0xFF);
  green = static_cast<uint8_t>((parsed >> 8) & 0xFF);
  blue = static_cast<uint8_t>(parsed & 0xFF);
  return true;
}

bool parsePaletteConfigCommand(
    const String &line, int &slotIndex, uint8_t &red, uint8_t &green, uint8_t &blue) {
  if (!line.startsWith("PC ")) {
    return false;
  }

  const int firstSpace = line.indexOf(' ');
  const int secondSpace = line.indexOf(' ', firstSpace + 1);

  if (secondSpace < 0) {
    return false;
  }

  slotIndex = line.substring(firstSpace + 1, secondSpace).toInt();
  return parseHexColorToken(line.substring(secondSpace + 1), red, green, blue);
}

bool parseBasicColorConfigCommand(const String &line, int &slotIndex, int &row, int &col) {
  if (!line.startsWith("BC ")) {
    return false;
  }

  const int firstSpace = line.indexOf(' ');
  const int secondSpace = line.indexOf(' ', firstSpace + 1);
  const int thirdSpace = line.indexOf(' ', secondSpace + 1);

  if (secondSpace < 0 || thirdSpace < 0) {
    return false;
  }

  slotIndex = line.substring(firstSpace + 1, secondSpace).toInt();
  row = line.substring(secondSpace + 1, thirdSpace).toInt();
  col = line.substring(thirdSpace + 1).toInt();
  return true;
}

bool isBasicColorResetCommand(const String &line) { return line == "BC RESET"; }

bool parseStickCommand(const String &line, int &x, int &y, uint16_t &holdMs) {
  if (!line.startsWith("STICK ")) {
    return false;
  }

  int parsedHoldMs = 0;
  if (!parseThreeInts(line, x, y, parsedHoldMs)) {
    return false;
  }

  if (x < -1 || x > 1 || y < -1 || y > 1 || (x == 0 && y == 0)) {
    return false;
  }

  if (parsedHoldMs <= 0 || parsedHoldMs > 60000) {
    return false;
  }

  holdMs = static_cast<uint16_t>(parsedHoldMs);
  return true;
}

bool parseHoldButtonCommand(const String &line, ControllerButton &button, uint16_t &holdMs) {
  if (!line.startsWith("HOLD ")) {
    return false;
  }

  const int firstSpace = line.indexOf(' ');
  const int secondSpace = line.indexOf(' ', firstSpace + 1);

  if (secondSpace < 0) {
    return false;
  }

  bool ok = false;
  button = parseButton(line.substring(firstSpace + 1, secondSpace), ok);

  if (!ok) {
    return false;
  }

  const int parsed = line.substring(secondSpace + 1).toInt();

  if (parsed <= 0 || parsed > 60000) {
    return false;
  }

  holdMs = static_cast<uint16_t>(parsed);
  return true;
}

bool parseTapButtonCommand(const String &line, ControllerButton &button, uint16_t &count) {
  if (!line.startsWith("TAP ")) {
    return false;
  }

  const int firstSpace = line.indexOf(' ');
  const int secondSpace = line.indexOf(' ', firstSpace + 1);

  if (secondSpace < 0) {
    return false;
  }

  bool ok = false;
  button = parseButton(line.substring(firstSpace + 1, secondSpace), ok);

  if (!ok) {
    return false;
  }

  const int parsed = line.substring(secondSpace + 1).toInt();

  if (parsed <= 0 || parsed > 2000) {
    return false;
  }

  count = static_cast<uint16_t>(parsed);
  return true;
}

ControllerButton parseButton(const String &line, bool &ok) {
  ok = true;

  if (line == "A") {
    return ControllerButton::A;
  }

  if (line == "B") {
    return ControllerButton::B;
  }

  if (line == "X") {
    return ControllerButton::X;
  }

  if (line == "Y") {
    return ControllerButton::Y;
  }

  if (line == "L") {
    return ControllerButton::L;
  }

  if (line == "R") {
    return ControllerButton::R;
  }

  if (line == "ZL") {
    return ControllerButton::ZL;
  }

  if (line == "ZR") {
    return ControllerButton::ZR;
  }

  if (line == "+" || line == "PLUS") {
    return ControllerButton::Plus;
  }

  if (line == "-" || line == "MINUS") {
    return ControllerButton::Minus;
  }

  if (line == "HOME") {
    return ControllerButton::Home;
  }

  if (line == "CAPTURE" || line == "CAP") {
    return ControllerButton::Capture;
  }

  if (line == "LS" || line == "L3") {
    return ControllerButton::LStick;
  }

  if (line == "RS" || line == "R3") {
    return ControllerButton::RStick;
  }

  if (line == "DUP" || line == "UP") {
    return ControllerButton::DpadUp;
  }

  if (line == "DDOWN" || line == "DOWN") {
    return ControllerButton::DpadDown;
  }

  if (line == "DLEFT" || line == "LEFT") {
    return ControllerButton::DpadLeft;
  }

  if (line == "DRIGHT" || line == "RIGHT") {
    return ControllerButton::DpadRight;
  }

  ok = false;
  return ControllerButton::A;
}

constexpr uint8_t MAX_COMBO_BUTTONS = 4;

bool parseButtonCommand(
    const String &line,
    ControllerButton &button,
    uint32_t &buttonsMask,
    bool &isCombo,
    String &comboName) {
  if (!line.startsWith("BTN ")) {
    return false;
  }

  const String token = line.substring(4);

  if (token == "LR" || token == "L+R") {
    buttonsMask =
        controllerButtonMask(ControllerButton::L) | controllerButtonMask(ControllerButton::R);
    isCombo = true;
    comboName = "L+R";
    return true;
  }

  bool ok = false;
  const ControllerButton singleButton = parseButton(token, ok);

  if (ok) {
    button = singleButton;
    buttonsMask = controllerButtonMask(singleButton);
    isCombo = false;
    comboName = token;
    return true;
  }

  // Generic simultaneous-press combo, e.g. "BTN A+B+X+Y" (2 to 4 buttons).
  if (token.indexOf('+') < 0) {
    return false;
  }

  uint32_t parsedMask = 0;
  uint8_t parsedCount = 0;
  int start = 0;

  while (start <= static_cast<int>(token.length())) {
    const int separator = token.indexOf('+', start);
    const int end = separator < 0 ? static_cast<int>(token.length()) : separator;
    const String part = token.substring(start, end);

    bool partOk = false;
    const ControllerButton partButton = parseButton(part, partOk);

    if (!partOk) {
      return false;
    }

    parsedMask |= controllerButtonMask(partButton);
    parsedCount += 1;

    if (parsedCount > MAX_COMBO_BUTTONS) {
      return false;
    }

    if (separator < 0) {
      break;
    }

    start = separator + 1;
  }

  if (parsedCount < 2) {
    return false;
  }

  buttonsMask = parsedMask;
  isCombo = true;
  comboName = token;
  return true;
}

constexpr uint16_t MAX_SEQUENCE_WAIT_MS = 10000;
// Each BTN and each wait occupies one step, so 256 steps allow up to 128
// presses per line. Stored in static storage (see executeCommand) because the
// 8KB loop-task stack cannot hold the ~6KB SequenceStep array.
constexpr uint16_t MAX_SEQUENCE_STEPS = 256;

struct SequenceStep {
  bool isWait;
  uint32_t buttonsMask;
  bool isCombo;
  ControllerButton button;
  uint16_t waitMs;
  String name;
};

enum class SequenceParseResult { None, Invalid, Ok };

bool parseSequenceWaitToken(const String &token, uint16_t &waitMs) {
  // Explicit rhythm wait, e.g. "40ms" (0 to 10000 milliseconds).
  if (token.length() < 3 || token.length() > 7 || !token.endsWith("ms")) {
    return false;
  }

  const String digits = token.substring(0, token.length() - 2);
  if (digits.length() == 0) {
    return false;
  }

  for (unsigned int index = 0; index < digits.length(); index += 1) {
    if (!isDigit(static_cast<unsigned char>(digits.charAt(index)))) {
      return false;
    }
  }

  const long value = digits.toInt();
  if (value < 0 || value > MAX_SEQUENCE_WAIT_MS) {
    return false;
  }

  waitMs = static_cast<uint16_t>(value);
  return true;
}

// Parses a single-line rhythm sequence such as:
//   BTN A 40ms BTN B 80ms BTN A+B
//   40ms
// "BTN <spec>" taps a button (or combo), and "<n>ms" gives the post-release
// settle window for the preceding button. A leading wait is a plain delay.
// Waits must not be adjacent and every BTN needs a button spec.
SequenceParseResult parseSequenceCommand(
    const String &line, SequenceStep *steps, uint16_t &stepCount) {
  stepCount = 0;

  int cursor = 0;
  const int length = static_cast<int>(line.length());
  bool sawSequenceToken = false;
  bool expectButtonSpec = false;
  bool lastWasWait = false;
  uint16_t pressCount = 0;

  while (cursor < length) {
    while (cursor < length && line.charAt(cursor) == ' ') {
      cursor += 1;
    }

    if (cursor >= length) {
      break;
    }

    const int tokenStart = cursor;
    while (cursor < length && line.charAt(cursor) != ' ') {
      cursor += 1;
    }
    const String token = line.substring(tokenStart, cursor);

    if (expectButtonSpec) {
      ControllerButton specButton = ControllerButton::A;
      uint32_t specMask = 0;
      bool specIsCombo = false;
      String specName;

      if (!parseButtonCommand(
              String("BTN ") + token, specButton, specMask, specIsCombo, specName)) {
        return SequenceParseResult::Invalid;
      }

      if (stepCount >= MAX_SEQUENCE_STEPS) {
        return SequenceParseResult::Invalid;
      }

      SequenceStep &step = steps[stepCount];
      step.isWait = false;
      step.buttonsMask = specMask;
      step.isCombo = specIsCombo;
      step.button = specButton;
      step.waitMs = 0;
      step.name = specName;
      stepCount += 1;
      pressCount += 1;
      expectButtonSpec = false;
      lastWasWait = false;
      continue;
    }

    if (token == "BTN") {
      sawSequenceToken = true;
      expectButtonSpec = true;
      continue;
    }

    uint16_t waitMs = 0;
    if (parseSequenceWaitToken(token, waitMs)) {
      sawSequenceToken = true;

      if (lastWasWait || stepCount >= MAX_SEQUENCE_STEPS) {
        return SequenceParseResult::Invalid;
      }

      SequenceStep &step = steps[stepCount];
      step.isWait = true;
      step.buttonsMask = 0;
      step.isCombo = false;
      step.button = ControllerButton::A;
      step.waitMs = waitMs;
      step.name = "";
      stepCount += 1;
      lastWasWait = true;
      continue;
    }

    return sawSequenceToken ? SequenceParseResult::Invalid : SequenceParseResult::None;
  }

  if (expectButtonSpec || !sawSequenceToken) {
    return expectButtonSpec ? SequenceParseResult::Invalid : SequenceParseResult::None;
  }

  if (pressCount == 0 && stepCount != 1) {
    return SequenceParseResult::Invalid;
  }

  return SequenceParseResult::Ok;
}

const char *buttonName(ControllerButton button) {
  switch (button) {
    case ControllerButton::A:
      return "A";
    case ControllerButton::B:
      return "B";
    case ControllerButton::X:
      return "X";
    case ControllerButton::Y:
      return "Y";
    case ControllerButton::L:
      return "L";
    case ControllerButton::R:
      return "R";
    case ControllerButton::ZL:
      return "ZL";
    case ControllerButton::ZR:
      return "ZR";
    case ControllerButton::Plus:
      return "PLUS";
    case ControllerButton::Minus:
      return "MINUS";
    case ControllerButton::Home:
      return "HOME";
    case ControllerButton::Capture:
      return "CAPTURE";
    case ControllerButton::LStick:
      return "LS";
    case ControllerButton::RStick:
      return "RS";
    case ControllerButton::DpadUp:
      return "DUP";
    case ControllerButton::DpadDown:
      return "DDOWN";
    case ControllerButton::DpadLeft:
      return "DLEFT";
    case ControllerButton::DpadRight:
      return "DRIGHT";
    default:
      return "?";
  }
}

}  // namespace

// NOTE <按键> <摇杆档位 -2..2> <按住ms>：时之笛陶笛的单音（按键+摇杆同帧按下）
bool parseNoteCommand(
    const String &line, ControllerButton &button, int &stickLevel, uint16_t &holdMs) {
  if (!line.startsWith("NOTE ")) {
    return false;
  }

  const int firstSpace = line.indexOf(' ');
  const int secondSpace = line.indexOf(' ', firstSpace + 1);
  const int thirdSpace = line.indexOf(' ', secondSpace + 1);

  if (secondSpace < 0 || thirdSpace < 0) {
    return false;
  }

  bool ok = false;
  button = parseButton(line.substring(firstSpace + 1, secondSpace), ok);
  if (!ok) {
    return false;
  }

  const int level = line.substring(secondSpace + 1, thirdSpace).toInt();
  if (level < -2 || level > 2) {
    return false;
  }

  const int hold = line.substring(thirdSpace + 1).toInt();
  if (hold <= 0 || hold > 60000) {
    return false;
  }

  stickLevel = level;
  holdMs = static_cast<uint16_t>(hold);
  return true;
}

bool executeCommand(const String &line, SwitchController &controller, String &error) {
  if (line.length() == 0) {
    return true;
  }

  if (line == "I") {
    Serial.printf("INFO transport=%s\n", controller.transportName());
    controller.printTransportStatus(Serial);
    return true;
  }

  if (line == "BT RESET" || line == "BT RESET LAST-PEER") {
    const bool reconnectLastPeer = line == "BT RESET LAST-PEER";
    if (!controller.resetBluetooth(reconnectLastPeer)) {
      error = "bt reset failed";
      return false;
    }

    Serial.printf(
        "INFO action=bt-reset requested_reconnect_last_peer=%s\n",
        reconnectLastPeer ? "true" : "false");
    return true;
  }

  if (line == "BT DISCONNECT") {
    const bool ok = controller.disconnectBluetooth();
    Serial.printf("INFO action=bt-disconnect ok=%s\n", ok ? "true" : "false");
    if (!ok) {
      error = "bt disconnect failed";
      return false;
    }
    return true;
  }

  if (line == "BT CONNECT") {
    const bool ok = controller.connectBluetooth();
    Serial.printf("INFO action=bt-connect ok=%s\n", ok ? "true" : "false");
    if (!ok) {
      error = "bt connect failed";
      return false;
    }
    return true;
  }

  if (line == "BT CLEAR-PEER") {
    if (!controller.clearBluetoothPeer()) {
      error = "bt clear-peer failed";
      return false;
    }

    Serial.println("INFO action=bt-clear-peer");
    return true;
  }

  uint16_t buttonPressMs = 0;
  uint16_t inputDelayMs = 0;
  uint16_t homeMs = 0;

  if (parseInputConfigCommand(line, buttonPressMs, inputDelayMs, homeMs)) {
    controller.configureInputTiming(buttonPressMs, inputDelayMs, homeMs);
    Serial.printf(
        "INFO action=input-config button=%u delay=%u home=%u\n",
        buttonPressMs,
        inputDelayMs,
        homeMs);
    return true;
  }

  if (line.startsWith("CFG INPUT")) {
    error = "invalid input config";
    return false;
  }

  if (line == "H") {
    if (!controller.moveHome()) {
      return failControllerInput(error);
    }
    Serial.println("INFO action=home");
    return true;
  }

  if (line == "P") {
    if (!controller.drawStroke()) {
      return failControllerInput(error);
    }
    Serial.println("INFO action=draw button=A");
    return true;
  }

  if (line == "LR" || line == "L+R") {
    if (!controller.pressButtons(controllerButtonMask(ControllerButton::L) |
                                 controllerButtonMask(ControllerButton::R))) {
      return failControllerInput(error);
    }
    Serial.println("INFO action=combo name=L+R");
    return true;
  }

  ControllerButton noteButton = ControllerButton::A;
  int noteLevel = 0;
  uint16_t noteHoldMs = 0;
  if (parseNoteCommand(line, noteButton, noteLevel, noteHoldMs)) {
    if (!controller.pressNote(controllerButtonMask(noteButton), noteLevel, noteHoldMs)) {
      return failControllerInput(error);
    }
    Serial.printf("INFO action=note name=%s level=%d ms=%u\n",
                  buttonName(noteButton), noteLevel, noteHoldMs);
    return true;
  }

  ControllerButton commandButton = ControllerButton::A;
  uint32_t commandButtonsMask = 0;
  bool isComboCommand = false;
  String commandComboName;

  if (parseButtonCommand(
          line, commandButton, commandButtonsMask, isComboCommand, commandComboName)) {
    if (isComboCommand) {
      if (!controller.pressButtons(commandButtonsMask)) {
        return failControllerInput(error);
      }
      Serial.printf("INFO action=combo name=%s\n", commandComboName.c_str());
      return true;
    }

    if (!controller.pressButton(commandButton)) {
      return failControllerInput(error);
    }
    // 进度语义事件：上位机 UI 靠它实时推进“演奏中 X/N”，即使
    // RHD_SILENCE_INFO_LOGS=1（Switch2）也必须输出。
    Serial.printf("INFO action=button name=%s\n", buttonName(commandButton));
    return true;
  }

  // Static storage: 256 SequenceSteps (~6KB) overflow the 8KB loop-task stack.
  // executeCommand only runs on the single loop task (never reentrant), and
  // parseSequenceCommand resets the count and overwrites every used step.
  static SequenceStep sequenceSteps[MAX_SEQUENCE_STEPS];
  uint16_t sequenceStepCount = 0;
  const SequenceParseResult sequenceResult =
      parseSequenceCommand(line, sequenceSteps, sequenceStepCount);

  if (sequenceResult == SequenceParseResult::Invalid) {
    error = "invalid sequence";
    return false;
  }

  // A lone "BTN A" keeps the legacy path above; sequences and bare wait lines
  // (e.g. "40ms") execute here.
  if (sequenceResult == SequenceParseResult::Ok &&
      !(sequenceStepCount == 1 && !sequenceSteps[0].isWait)) {
#if RHD_PROBE_INPUT
    Serial.printf("PROBE seq begin steps=%u\n",
                  static_cast<unsigned>(sequenceStepCount));
#endif
    // 块内节奏锁相（phase-locked schedule）。以第一击入口为锚点维护名义
    // 时间线：第 k 击目标 onset = 锚点 + Σ(hold + settle + 每步预留)；
    // 每击入口实测与计划的偏差反馈修正【本击 settle】（决定下一击 onset），
    // 自动吸收蓝牙报告 ACK、加固窗等逐拍耗时，实际间隔与探针/正式日志量
    // 无关（日志均走 2048B 异步 TX 缓冲，不阻塞）。
    // 预留常数必须与 app.js 的 FIRMWARE_STEP_OVERHEAD_MS 一致（=9ms）。
    // 前馈 = 预留 9ms − 2026-09-16 实测真实逐拍开销 5.6ms（PROBE tap
    // win/span 反解）：物理上缺的 3.4ms 必须加长 settle 补足；有前馈后
    // 装饰音等间隔切换的第一步也能立即命中，不必等一拍反馈。反馈环负责
    // 吸收抖动与前馈误差（积分型，稳态无差）。只在单条 SEQ 命令内锁定，
    // 块尾音不修正（下一拍跨块，接缝归上位机传输补偿管）。
    constexpr uint32_t kSequenceStepOverheadUs = 9000;
    constexpr int32_t kScheduleFeedforwardUs = 3400;
    constexpr int32_t kScheduleFeedbackLimitUs = 2000;
    constexpr int32_t kScheduleTotalLimitUs = 5000;
    constexpr int32_t kScheduleMinSettleUs = 70000; // 加固30 + 最小释放窗40
    uint16_t lastPressIndex = 0;
    for (uint16_t scan = 0; scan < sequenceStepCount; scan += 1) {
      if (!sequenceSteps[scan].isWait) {
        lastPressIndex = scan;
      }
    }
    uint32_t scheduleAnchorUs = 0;
    uint64_t schedulePlannedUs = 0;
    for (uint16_t index = 0; index < sequenceStepCount; index += 1) {
      const SequenceStep &step = sequenceSteps[index];

      if (step.isWait) {
        // A wait immediately after a press becomes that press's settle window.
        if (index > 0 && !sequenceSteps[index - 1].isWait) {
          continue;
        }

        delay(step.waitMs);
        // 独立裸等待（长休止拆分/块首前置）：锚点已立则把名义时间线推后；
        // 块首前置等待发生在锚点之前，不计入。
        if (scheduleAnchorUs != 0) {
          schedulePlannedUs += static_cast<uint64_t>(step.waitMs) * 1000ULL;
        }
        // 进度语义事件（UI“等待 Nms”展示），不受静默宏影响。
        Serial.printf("INFO action=wait ms=%u\n", static_cast<unsigned>(step.waitMs));
        continue;
      }

      const bool hasExplicitSettle =
          index + 1 < sequenceStepCount && sequenceSteps[index + 1].isWait;
      const uint16_t settleMs = hasExplicitSettle
          ? sequenceSteps[index + 1].waitMs
          : controller.inputDelayMs();

      const uint32_t nowUs = micros();
      uint16_t effectiveSettleMs = settleMs;
      const bool isChunkTail = (index == lastPressIndex);
      if (!isChunkTail) {
        // 块尾音不锁相（下一拍跨块，接缝由上位机补偿）。
        // phaseErr>0：实际 onset 晚于计划（偏慢）→ 缩短 settle；负值加长。
        // 总调整 = 前馈（补偿固定开销差）− 相位误差；首击相位误差视为 0
        // （锚点），但仍施加前馈，使第二拍起即命中、无收敛过冲。反馈分量
        // 限幅防突发链路抖动造成单步可听突变，总量限幅保住 settle 安全窗。
        int64_t phaseErrorUs = 0;
        if (scheduleAnchorUs != 0) {
          phaseErrorUs =
              static_cast<int64_t>(nowUs - scheduleAnchorUs) -
              static_cast<int64_t>(schedulePlannedUs);
          if (phaseErrorUs > kScheduleFeedbackLimitUs) {
            phaseErrorUs = kScheduleFeedbackLimitUs;
          } else if (phaseErrorUs < -kScheduleFeedbackLimitUs) {
            phaseErrorUs = -kScheduleFeedbackLimitUs;
          }
        }
        int32_t adjustmentUs =
            kScheduleFeedforwardUs - static_cast<int32_t>(phaseErrorUs);
        if (adjustmentUs > kScheduleTotalLimitUs) {
          adjustmentUs = kScheduleTotalLimitUs;
        } else if (adjustmentUs < -kScheduleTotalLimitUs) {
          adjustmentUs = -kScheduleTotalLimitUs;
        }
        int32_t correctedSettleUs =
            static_cast<int32_t>(static_cast<uint32_t>(settleMs) * 1000U) +
            adjustmentUs;
        if (correctedSettleUs < kScheduleMinSettleUs) {
          correctedSettleUs = kScheduleMinSettleUs;
        }
        effectiveSettleMs =
            static_cast<uint16_t>((correctedSettleUs + 500) / 1000);
      }
      if (scheduleAnchorUs == 0) {
        scheduleAnchorUs = nowUs;
      }

#if RHD_PROBE_INPUT
      Serial.printf("PROBE seq i=%u/%u settle=%u eff=%u t=%lu\n",
                    static_cast<unsigned>(index + 1),
                    static_cast<unsigned>(sequenceStepCount),
                    static_cast<unsigned>(settleMs),
                    static_cast<unsigned>(effectiveSettleMs),
                    static_cast<unsigned long>(nowUs / 1000));
#endif
      if (!controller.tapButtons(step.buttonsMask, effectiveSettleMs)) {
        return failControllerInput(error);
      }

      // 推进名义时间线：始终用【原始】hold + settle + 预留，与反馈修正无关。
      schedulePlannedUs +=
          static_cast<uint64_t>(controller.buttonPressMs()) * 1000ULL +
          static_cast<uint64_t>(settleMs) * 1000ULL +
          kSequenceStepOverheadUs;

      // 每击进度语义事件：上位机 UI 据此实时推进“演奏中 X/N”，不受
      // RHD_SILENCE_INFO_LOGS 影响（走缓冲串口，单行约 26 字节，已验证对
      // 敲击时序无可测影响）。
      if (step.isCombo) {
        Serial.printf("INFO action=combo name=%s\n", step.name.c_str());
      } else {
        Serial.printf("INFO action=button name=%s\n", buttonName(step.button));
      }
    }

    return true;
  }

  if (line == "S") {
    controller.pause();
    Serial.println("INFO action=pause");
    return true;
  }

  if (line == "R") {
    controller.resume();
    Serial.println("INFO action=resume");
    return true;
  }

  if (line == "E") {
    controller.end();
    Serial.println("INFO action=end");
    return true;
  }

  if (line.startsWith("M ")) {
    int dx = 0;
    int dy = 0;

    if (!parseTwoInts(line, dx, dy)) {
      error = "invalid move";
      return false;
    }

    if (!controller.moveCursor(dx, dy)) {
      return failControllerInput(error);
    }
    Serial.printf("INFO action=move dx=%d dy=%d\n", dx, dy);
    return true;
  }

  int stickX = 0;
  int stickY = 0;
  uint16_t stickHoldMs = 0;

  if (parseStickCommand(line, stickX, stickY, stickHoldMs)) {
    if (!controller.moveStick(stickX, stickY, stickHoldMs)) {
      return failControllerInput(error);
    }
    Serial.printf("INFO action=stick x=%d y=%d ms=%u\n", stickX, stickY, stickHoldMs);
    return true;
  }

  if (line.startsWith("L ")) {
    int dx = 0;
    int dy = 0;
    uint8_t stride = 1;

    if (!parseLineCommand(line, dx, dy, stride) || (dx == 0 && dy == 0) || (dx != 0 && dy != 0)) {
      error = "invalid line";
      return false;
    }

    if (!controller.drawLine(dx, dy, stride)) {
      return failControllerInput(error);
    }

    Serial.printf("INFO action=line dx=%d dy=%d stride=%u\n", dx, dy, stride);
    return true;
  }

  ControllerButton holdButton = ControllerButton::A;
  uint16_t holdMs = 0;

  if (parseHoldButtonCommand(line, holdButton, holdMs)) {
    if (!controller.holdButton(holdButton, holdMs)) {
      return failControllerInput(error);
    }
    Serial.printf("INFO action=hold button=%s ms=%u\n", buttonName(holdButton), holdMs);
    return true;
  }

  uint16_t tapCount = 0;

  if (parseTapButtonCommand(line, holdButton, tapCount)) {
    if (!controller.tapButton(holdButton, tapCount)) {
      return failControllerInput(error);
    }
    Serial.printf("INFO action=tap button=%s count=%u\n", buttonName(holdButton), tapCount);
    return true;
  }

  uint8_t paletteRed = 0;
  uint8_t paletteGreen = 0;
  uint8_t paletteBlue = 0;
  int paletteSlotIndex = 0;

  if (parsePaletteConfigCommand(line, paletteSlotIndex, paletteRed, paletteGreen, paletteBlue)) {
    if (!controller.configurePaletteSlot(paletteSlotIndex, paletteRed, paletteGreen, paletteBlue)) {
      return failControllerInput(error);
    }
    Serial.printf(
        "INFO action=palette-config slot=%d hex=#%02X%02X%02X\n",
        paletteSlotIndex,
        paletteRed,
        paletteGreen,
        paletteBlue);
    return true;
  }

  int basicColorRow = 0;
  int basicColorCol = 0;

  if (isBasicColorResetCommand(line)) {
    controller.resetBasicPaletteTracking();
    Serial.println("INFO action=basic-color-reset anchor=default-initial-slots");
    return true;
  }

  if (parseBasicColorConfigCommand(line, paletteSlotIndex, basicColorRow, basicColorCol)) {
    if (!controller.configureBasicPaletteSlot(
            paletteSlotIndex, static_cast<uint8_t>(basicColorRow), static_cast<uint8_t>(basicColorCol))) {
      return failControllerInput(error);
    }
    Serial.printf(
        "INFO action=basic-color-config slot=%d row=%d col=%d\n",
        paletteSlotIndex,
        basicColorRow,
        basicColorCol);
    return true;
  }

  if (line.startsWith("C ")) {
    int index = 0;

    if (!parseOneInt(line, index)) {
      error = "invalid color";
      return false;
    }

    if (!controller.selectColor(index)) {
      return failControllerInput(error);
    }
    Serial.printf("INFO action=color slot=%d\n", index);
    return true;
  }

  if (line.startsWith("W ")) {
    int delayMs = 0;

    if (!parseOneInt(line, delayMs)) {
      error = "invalid wait";
      return false;
    }

    delay(delayMs);
    Serial.printf("INFO action=wait ms=%d\n", delayMs);
    return true;
  }

  bool ok = false;
  const ControllerButton button = parseButton(line, ok);

  if (ok) {
    if (!controller.pressButton(button)) {
      return failControllerInput(error);
    }
    // 进度语义事件：UI“演奏中 X/N”依赖，不受静默宏影响。
    Serial.printf("INFO action=button name=%s\n", buttonName(button));
    return true;
  }

  error = "unknown command";
  return false;
}
