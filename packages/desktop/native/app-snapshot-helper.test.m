#define APP_SNAPSHOT_HELPER_TESTING 1
#import "app-snapshot-helper.m"

static void require(BOOL condition, NSString *message) {
  if (condition) return;
  fprintf(stderr, "%s\n", message.UTF8String);
  exit(1);
}

static NSDictionary *testWindow(pid_t processIdentifier, NSInteger windowID, CGRect bounds) {
  return @{
    (__bridge NSString *)kCGWindowOwnerPID: @(processIdentifier),
    (__bridge NSString *)kCGWindowNumber: @(windowID),
    (__bridge NSString *)kCGWindowLayer: @0,
    (__bridge NSString *)kCGWindowAlpha: @1,
    (__bridge NSString *)kCGWindowBounds: CFBridgingRelease(CGRectCreateDictionaryRepresentation(bounds)),
  };
}

static void testTextLimit(void) {
  NSMutableArray<NSString *> *output = [NSMutableArray array];
  NSMutableSet<NSString *> *seen = [NSMutableSet set];
  NSUInteger characters = 0;
  require(!appendAccessibleText(output, seen, @"ab", 5, &characters), @"first value should fit");
  require(!appendAccessibleText(output, seen, @"cd", 5, &characters), @"second value should exactly fill the limit");
  require(characters == 5, @"character count must include the separator without exceeding the limit");
  require([[output componentsJoinedByString:@"\n"] isEqualToString:@"ab\ncd"], @"values should fill the exact limit");
  require(appendAccessibleText(output, seen, @"g", 5, &characters), @"full output must remain safely truncated");
  require(characters == 5, @"full output must not overflow or underflow");
}

static void testFocusedWindowSelection(void) {
  pid_t processIdentifier = 42;
  CGRect frontWindow = CGRectMake(100, 80, 1400, 900);
  CGRect focusedWindow = CGRectMake(2100, 120, 800, 600);
  NSArray *windows = @[
    testWindow(processIdentifier, 1, frontWindow),
    testWindow(processIdentifier, 2, focusedWindow),
  ];

  NSDictionary *focused = selectCaptureWindow(windows, processIdentifier, &focusedWindow);
  require([focused[(__bridge NSString *)kCGWindowNumber] integerValue] == 2,
          @"focused bounds must select the matching window on the second display");
  NSDictionary *layered = selectCaptureWindow(windows, processIdentifier, NULL);
  require([layered[(__bridge NSString *)kCGWindowNumber] integerValue] == 1,
          @"without Accessibility bounds the frontmost CGWindow must win");
}

int main(void) {
  @autoreleasepool {
    testTextLimit();
    testFocusedWindowSelection();
  }
  return 0;
}
