#pragma once

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "controller_transport.h"

class ClassicBtControllerTransport : public ControllerTransport {
 public:
  void begin() override;
  bool pressButtons(uint32_t buttonsMask, uint16_t holdMs, uint16_t settleMs) override;
  bool pressButtonsReliable(uint32_t buttonsMask, uint16_t holdMs, uint16_t settleMs) override;
  bool moveDirection(int x, int y, uint16_t holdMs, uint16_t settleMs) override;
  void setNextStickLevel(int level) override;
  bool resetConnection(bool reconnectLastPeer = false) override;
  bool clearStoredPeer() override;
  void printStatus(Print &output) const override;
  const char *name() const override;

 private:
  bool initializeClassicBluetooth();
  bool initializeNvsAndBaseAddress();
  bool shutdownClassicBluetooth();
  void clearConnectionState();
  void clearInputs();
  void setButtonBits(uint32_t buttonsMask);
  void setLeftStickFromVector(int x, int y);
  void updateInputReport();
  void logInputReport(const char *command, const char *phase) const;
  void ensureSendTask();
  uint16_t idleSendIntervalMs() const;
  bool isHidReportChannelOpen() const;
  bool isControllerInputReady() const;
  bool sendCurrentInputReport(bool logFailure, bool waitForSendEvent = false);
  bool repeatCurrentInputReport(
      uint16_t durationMs,
      bool logFailure,
      bool waitForSendEvent,
      uint16_t congestionRetryBudgetMs);
  // 微秒精度版本：末段用 micros() 自旋消除 FreeRTOS 1ms tick 取整超调，
  // 使每步 hold/settle 实际时长误差 <0.1ms，且不受日志输出量影响。
  bool repeatCurrentInputReportUs(
      uint32_t durationUs,
      bool logFailure,
      bool waitForSendEvent,
      uint16_t congestionRetryBudgetMs);
  bool shouldRetryAfterTransientSendFailure() const;
  bool shouldDelayInputReports() const;
  uint32_t inputReportsQuietUntilMs() const;
  bool waitForInputReportAccepted(uint32_t expectedEventCount, bool logFailure);
  bool waitForInputReportDrain(uint32_t timeoutMs, bool logFailure);
  bool beginExplicitInput(bool waitForDrain);
  void endExplicitInput();
  void resetInputReportTracking();
  bool clearBondedPeerDevices();
  bool clearPersistedPeerAddress();
  void markControllerPaired();
  bool sendSubcommandReply(uint8_t reportId, const uint8_t *data, size_t length, const char *label);
  bool attemptVirtualCablePlug(const uint8_t peerAddress[6], const char *reason);
  void enterReconnectableState(const char *reason);
  void processIncomingReport(uint8_t reportId, uint16_t len, uint8_t *data);
  void handleGapEvent(int event, void *param);
  void handleHidEvent(int event, void *param);

  static void onGapEvent(int event, void *param);
  static void onHidEvent(int event, void *param);
  static void sendTaskTrampoline(void *param);

  static ClassicBtControllerTransport *instance_;

  bool stackStarted_ = false;
  bool bluedroidReady_ = false;
  bool gapReady_ = false;
  bool hidReady_ = false;
  bool appRegistered_ = false;
  bool discoverable_ = false;
  bool connected_ = false;
  bool readyForReports_ = false;
  bool authComplete_ = false;
  bool pairingComplete_ = false;
  bool paired_ = false;
  uint8_t timer_ = 0;
  const char *initStep_ = "idle";
  const char *initError_ = "none";
  uint8_t buttonsRight_ = 0;
  uint8_t buttonsShared_ = 0;
  uint8_t buttonsLeft_ = 0;
  uint8_t leftStickX_ = 128;
  uint8_t leftStickY_ = 128;
  uint8_t rightStickX_ = 128;
  uint8_t rightStickY_ = 128;
  uint8_t report30_[48] = {};
  uint8_t dummyReport_[11] = {};
  SemaphoreHandle_t inputReportSendMutex_ = nullptr;
  TaskHandle_t sendTaskHandle_ = nullptr;
  volatile bool explicitInputActive_ = false;
  volatile uint32_t inputReportSubmitCount_ = 0;
  volatile uint32_t inputReportSendEventCount_ = 0;
  // 最近一次 0x30 输入报告被主机 ACK（SEND_REPORT_EVT 成功）的 millis()，
  // 用于 sniff 唤醒预热判断；0 表示尚无成功报告。
  volatile uint32_t lastInputReportAcceptedMs_ = 0;
  volatile int lastInputReportStatus_ = -1;
  volatile uint8_t lastInputReportReason_ = 0;
  uint32_t inputReportsQuietUntilMs_ = 0;
  uint8_t lastPeerAddress_[6] = {};
  bool hasPeerAddress_ = false;
  bool hasReconnectablePeer_ = false;
  uint32_t lastAutoRecoveryMs_ = 0;  // 上次自动重启蓝牙栈的时刻
  bool resetting_ = false;           // 正在拆/重建蓝牙栈，期间禁止发送
  bool reconnectLastPeerOnRegister_ = false;
  uint32_t ignoredReportCount_ = 0;
  uint8_t lastIgnoredReportId_ = 0;
  uint16_t lastIgnoredReportLen_ = 0;
  uint8_t lastAclDisconnectReason_ = 0;
  int lastHidCloseStatus_ = -1;
  int lastHidCloseConnStatus_ = -1;
  int lastSendReportStatus_ = -1;
  uint8_t lastSendReportReason_ = 0;
  uint8_t lastSendReportId_ = 0;
  bool reportCongested_ = false;
  uint8_t consecutiveSendReportFailures_ = 0;
  uint32_t sendReportFailureCount_ = 0;
  const char *lastDropReason_ = "none";
};
