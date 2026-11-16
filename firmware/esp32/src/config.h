#pragma once

#include <Arduino.h>

// 高频 INFO 日志开关：1 = 静音每次按键的 input_report 详细日志（单行约
// 120 字节、每击按下/释放各一条，会撑满 256B 串口环形缓冲并阻塞，早期实测
// 每音额外占用约 32ms、直接推迟 HID 报告发送）。SWITCH2 正式构建通过
// build_flags 定义 RHD_SILENCE_INFO_LOGS=1。
// 注意：每击的“INFO action=button/combo/wait”进度语义事件不受此宏控制——
// 上位机 UI 靠它们实时推进“演奏中 X/N”，单行仅约 26 字节，入环形缓冲即
// 返回，2026-09-15 PROBE 实测（每击 ~125 字节输出）对时序无可测影响。
#ifndef RHD_SILENCE_INFO_LOGS
#define RHD_SILENCE_INFO_LOGS 0
#endif

// 输入链路探针：1 = 每次按键在串口输出 PROBE 行（微秒级时间戳、按下/释放发送
// 成败、发送失败计数），用于排查漏音、节奏漂移和 sniff 唤醒抖动；默认关闭，
// switch2_probe 构建环境通过 build flag 打开。每行约 80 字节（~7ms 线时间，
// 但进入 256B 串口环形缓冲即返回，每音一条不会阻塞时序）。
#ifndef RHD_PROBE_INPUT
#define RHD_PROBE_INPUT 0
#endif

constexpr uint32_t SERIAL_BAUD_RATE = 115200;
constexpr uint16_t HOME_DURATION_MS = 1800;
constexpr uint16_t CELL_MOVE_DURATION_MS = 80;
constexpr uint16_t INPUT_DELAY_MS = 100;
constexpr uint16_t BUTTON_PRESS_DURATION_MS = 100;
constexpr uint16_t HID_REPEAT_INTERVAL_MS = 16;
constexpr uint16_t HID_SEND_REPORT_TIMEOUT_MS = 400;
constexpr uint8_t COLOR_PALETTE_SLOT_COUNT = 9;
constexpr uint8_t COLOR_PALETTE_RESET_TO_BOTTOM_STEPS = 18;
constexpr uint16_t COLOR_PALETTE_MENU_OPEN_SETTLE_MS = 180;
constexpr uint16_t COLOR_PALETTE_MENU_PRESS_DURATION_MS = 90;
constexpr uint16_t COLOR_PALETTE_MENU_INPUT_DELAY_MS = 150;
constexpr uint16_t COLOR_PALETTE_EDITOR_OPEN_SETTLE_MS = 180;
constexpr uint16_t COLOR_PALETTE_EDITOR_HUE_RESET_HOLD_MS = 2500;
constexpr uint16_t COLOR_PALETTE_EDITOR_HUE_STEP_COUNT = 200;
constexpr uint16_t COLOR_PALETTE_EDITOR_SATURATION_STEP_COUNT = 213;
constexpr uint16_t COLOR_PALETTE_EDITOR_VALUE_STEP_COUNT = 112;
constexpr uint16_t COLOR_PALETTE_EDITOR_RESET_UP_HOLD_MS = 1500;
constexpr uint16_t COLOR_PALETTE_EDITOR_RESET_LEFT_HOLD_MS = 3000;
constexpr uint16_t COLOR_PALETTE_EDITOR_MOVE_STEP_MS = 20;
constexpr uint16_t COLOR_PALETTE_EDITOR_HUE_RESET_SETTLE_MS = 500;
constexpr uint8_t BASIC_COLOR_GRID_ROWS = 7;
constexpr uint8_t BASIC_COLOR_GRID_COLS = 12;
constexpr uint16_t BASIC_COLOR_TAB_SETTLE_MS = 140;
constexpr uint8_t BASIC_COLOR_ANCHOR_ROW = 0;
constexpr uint8_t BASIC_COLOR_ANCHOR_COL = 0;
constexpr uint8_t BASIC_COLOR_INITIAL_SLOT_ROWS[COLOR_PALETTE_SLOT_COUNT] = {6, 0, 3, 3, 3, 3, 3, 3, 3};
constexpr uint8_t BASIC_COLOR_INITIAL_SLOT_COLS[COLOR_PALETTE_SLOT_COUNT] = {0, 0, 10, 9, 8, 6, 5, 2, 1};
constexpr char FIRMWARE_NAME[] = "switch-auto-draw";
constexpr char BOARD_FAMILY[] = "esp32-classic";
constexpr char BT_DEVICE_NAME[] = "Pro Controller";
constexpr char BT_DEVICE_PROVIDER[] = "Nintendo";
constexpr char BT_DEVICE_DESCRIPTION[] = "Gamepad";
constexpr uint8_t BT_PAIR_PIN_LENGTH = 4;
constexpr char BT_PAIR_PIN[] = "1234";
constexpr uint8_t GAMEPAD_REPORT_ID = 1;

#if defined(SWITCH_AUTO_DRAW_USE_CLASSIC_BT)
constexpr char CONTROL_TRANSPORT[] = "classic-bt-uartswitchcon";
constexpr bool USE_MOCK_CONTROLLER = false;
#else
constexpr char CONTROL_TRANSPORT[] = "mock-classic-bt";
constexpr bool USE_MOCK_CONTROLLER = true;
#endif
