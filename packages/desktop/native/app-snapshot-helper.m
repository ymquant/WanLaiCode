#import <ApplicationServices/ApplicationServices.h>
#import <Cocoa/Cocoa.h>
#import <math.h>

static void emitJSON(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  if (!data) return;
  [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
  [[NSFileHandle fileHandleWithStandardOutput] writeData:[NSData dataWithBytes:"\n" length:1]];
}

static id copyAttribute(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value) return nil;
  return CFBridgingRelease(value);
}

static AXUIElementRef asElement(id value) {
  if (!value || CFGetTypeID((__bridge CFTypeRef)value) != AXUIElementGetTypeID()) return NULL;
  return (__bridge AXUIElementRef)value;
}

static NSArray *asElements(id value) {
  if (![value isKindOfClass:NSArray.class]) return @[];
  return [(NSArray *)value filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(id item, NSDictionary *_) {
    return asElement(item) != NULL;
  }]];
}

static NSString *asText(id value) {
  if ([value isKindOfClass:NSString.class]) return value;
  if ([value isKindOfClass:NSAttributedString.class]) return [(NSAttributedString *)value string];
  if ([value isKindOfClass:NSNumber.class]) return [(NSNumber *)value stringValue];
  return nil;
}

static NSString *normalizeText(NSString *value) {
  NSString *result = [value stringByReplacingOccurrencesOfString:@"\0" withString:@""];
  result = [result stringByReplacingOccurrencesOfString:@"[\\t\\r ]+"
                                             withString:@" "
                                                options:NSRegularExpressionSearch
                                                  range:NSMakeRange(0, result.length)];
  result = [result stringByReplacingOccurrencesOfString:@"\\n{3,}"
                                             withString:@"\n\n"
                                                options:NSRegularExpressionSearch
                                                  range:NSMakeRange(0, result.length)];
  return [result stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
}

static BOOL appendAccessibleText(NSMutableArray<NSString *> *output,
                                 NSMutableSet<NSString *> *seenText,
                                 NSString *value,
                                 NSUInteger maxCharacters,
                                 NSUInteger *characters) {
  if (!value.length || [seenText containsObject:value]) return NO;
  if (*characters >= maxCharacters) return YES;

  NSUInteger separatorLength = output.count > 0 ? 1 : 0;
  NSUInteger remaining = maxCharacters - *characters;
  if (remaining <= separatorLength) return YES;

  NSUInteger available = remaining - separatorLength;
  if (value.length > available) {
    [output addObject:[value substringToIndex:available]];
    *characters += separatorLength + available;
    return YES;
  }

  [seenText addObject:value];
  [output addObject:value];
  *characters += separatorLength + value.length;
  return NO;
}

static BOOL accessibilityWindowBounds(id value, CGRect *bounds) {
  AXUIElementRef element = asElement(value);
  if (!element) return NO;
  id positionValue = copyAttribute(element, kAXPositionAttribute);
  id sizeValue = copyAttribute(element, kAXSizeAttribute);
  if (!positionValue || !sizeValue) return NO;
  if (CFGetTypeID((__bridge CFTypeRef)positionValue) != AXValueGetTypeID() ||
      CFGetTypeID((__bridge CFTypeRef)sizeValue) != AXValueGetTypeID()) return NO;

  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  if (!AXValueGetValue((__bridge AXValueRef)positionValue, kAXValueCGPointType, &position) ||
      !AXValueGetValue((__bridge AXValueRef)sizeValue, kAXValueCGSizeType, &size)) return NO;
  if (size.width <= 0 || size.height <= 0) return NO;
  *bounds = (CGRect){ .origin = position, .size = size };
  return YES;
}

static BOOL captureWindowBounds(NSDictionary *window, CGRect *bounds) {
  id value = window[(__bridge NSString *)kCGWindowBounds];
  if (![value isKindOfClass:NSDictionary.class]) return NO;
  return CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)value, bounds);
}

static CGFloat windowBoundsDistance(CGRect left, CGRect right) {
  return fabs(CGRectGetMinX(left) - CGRectGetMinX(right)) +
         fabs(CGRectGetMinY(left) - CGRectGetMinY(right)) +
         fabs(CGRectGetWidth(left) - CGRectGetWidth(right)) +
         fabs(CGRectGetHeight(left) - CGRectGetHeight(right));
}

static NSDictionary *selectCaptureWindow(NSArray<NSDictionary *> *windows,
                                          pid_t processIdentifier,
                                          const CGRect *preferredBounds) {
  NSDictionary *first = nil;
  NSDictionary *closest = nil;
  CGFloat closestDistance = CGFLOAT_MAX;
  for (NSDictionary *info in windows) {
    if ([info[(__bridge NSString *)kCGWindowOwnerPID] intValue] != processIdentifier) continue;
    if ([info[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
    if ([info[(__bridge NSString *)kCGWindowAlpha] doubleValue] <= 0) continue;
    CGRect bounds = CGRectZero;
    if (!captureWindowBounds(info, &bounds)) continue;
    if (bounds.size.width < 80 || bounds.size.height < 80) continue;
    if (!first) first = info;
    if (!preferredBounds) continue;
    CGFloat distance = windowBoundsDistance(bounds, *preferredBounds);
    if (distance >= closestDistance) continue;
    closest = info;
    closestDistance = distance;
  }
  return preferredBounds ? (closest ?: first) : first;
}

static id closestAccessibilityWindow(NSArray *windows, CGRect target) {
  id closest = nil;
  CGFloat closestDistance = CGFLOAT_MAX;
  for (id window in windows) {
    CGRect bounds = CGRectZero;
    if (!accessibilityWindowBounds(window, &bounds)) continue;
    CGFloat distance = windowBoundsDistance(bounds, target);
    if (distance >= closestDistance) continue;
    closest = window;
    closestDistance = distance;
  }
  return closest;
}

static NSDictionary *accessibleText(id root) {
  if (!asElement(root)) return @{ @"text": @"", @"truncated": @NO };

  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3];
  const NSUInteger maxNodes = 4000;
  const NSUInteger maxCharacters = 120000;
  NSArray<NSString *> *valueAttributes = @[
    (__bridge NSString *)kAXTitleAttribute,
    (__bridge NSString *)kAXDescriptionAttribute,
    (__bridge NSString *)kAXHelpAttribute,
    (__bridge NSString *)kAXValueAttribute,
    (__bridge NSString *)kAXSelectedTextAttribute,
    (__bridge NSString *)kAXPlaceholderValueAttribute,
    @"AXDocument",
    @"AXURL",
  ];
  NSArray<NSString *> *childAttributes = @[
    (__bridge NSString *)kAXChildrenAttribute,
    @"AXRows",
    @"AXContents",
  ];
  NSMutableArray *queue = [NSMutableArray arrayWithObject:root];
  NSMutableSet<NSNumber *> *visited = [NSMutableSet set];
  NSMutableSet<NSString *> *seenText = [NSMutableSet set];
  NSMutableArray<NSString *> *output = [NSMutableArray array];
  NSUInteger index = 0;
  NSUInteger characters = 0;
  BOOL truncated = NO;

  while (index < queue.count) {
    if (index >= maxNodes || deadline.timeIntervalSinceNow <= 0) {
      truncated = YES;
      break;
    }

    id current = queue[index++];
    AXUIElementRef element = asElement(current);
    if (!element) continue;
    NSNumber *hash = @(CFHash(element));
    if ([visited containsObject:hash]) continue;
    [visited addObject:hash];

    BOOL secure = [asText(copyAttribute(element, kAXRoleAttribute)) isEqualToString:@"AXSecureTextField"];

    for (NSString *name in valueAttributes) {
      if (secure && ([name isEqualToString:(__bridge NSString *)kAXValueAttribute] ||
                     [name isEqualToString:(__bridge NSString *)kAXSelectedTextAttribute])) continue;
      NSString *value = normalizeText(asText(copyAttribute(element, (__bridge CFStringRef)name)) ?: @"");
      if (appendAccessibleText(output, seenText, value, maxCharacters, &characters)) {
        return @{ @"text": [output componentsJoinedByString:@"\n"], @"truncated": @YES };
      }
    }

    for (NSString *name in childAttributes) {
      [queue addObjectsFromArray:asElements(copyAttribute(element, (__bridge CFStringRef)name))];
    }
  }

  return @{ @"text": [output componentsJoinedByString:@"\n"], @"truncated": @(truncated) };
}

static void inspectFrontmostWindow(void) {
  NSRunningApplication *application = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!application) {
    emitJSON(@{ @"ok": @NO, @"code": @"no_frontmost_application", @"message": @"No frontmost application" });
    return;
  }

  NSArray<NSDictionary *> *windows = CFBridgingRelease(
    CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)
  );
  BOOL trusted = AXIsProcessTrusted();
  AXUIElementRef appElement = trusted ? AXUIElementCreateApplication(application.processIdentifier) : NULL;
  id focusedWindow = appElement ? copyAttribute(appElement, kAXFocusedWindowAttribute) : nil;
  NSArray *accessibilityWindows = appElement ? asElements(copyAttribute(appElement, kAXWindowsAttribute)) : @[];
  CGRect focusedBounds = CGRectZero;
  BOOL hasFocusedBounds = accessibilityWindowBounds(focusedWindow, &focusedBounds);
  NSDictionary *candidate = selectCaptureWindow(
    windows,
    application.processIdentifier,
    hasFocusedBounds ? &focusedBounds : NULL
  );

  NSNumber *windowID = candidate[(__bridge NSString *)kCGWindowNumber];
  if (!windowID) {
    if (appElement) CFRelease(appElement);
    emitJSON(@{ @"ok": @NO, @"code": @"no_frontmost_window", @"message": @"The frontmost application has no capturable window" });
    return;
  }

  CGRect candidateBounds = CGRectZero;
  captureWindowBounds(candidate, &candidateBounds);
  id accessibilityWindow = hasFocusedBounds
    ? focusedWindow
    : closestAccessibilityWindow(accessibilityWindows, candidateBounds);
  CGRect windowBounds = candidateBounds;
  accessibilityWindowBounds(accessibilityWindow, &windowBounds);
  AXUIElementRef accessibilityElement = asElement(accessibilityWindow);
  NSString *windowTitle = (accessibilityElement
    ? asText(copyAttribute(accessibilityElement, kAXTitleAttribute))
    : nil)
    ?: candidate[(__bridge NSString *)kCGWindowName]
    ?: @"";
  NSDictionary *extracted = trusted
    ? accessibleText(accessibilityWindow)
    : @{ @"text": @"", @"truncated": @NO };
  if (appElement) CFRelease(appElement);
  emitJSON(@{
    @"ok": @YES,
    @"appName": application.localizedName ?: @"Application",
    @"bundleIdentifier": application.bundleIdentifier ?: [NSNull null],
    @"processIdentifier": @(application.processIdentifier),
    @"windowID": windowID,
    @"windowTitle": windowTitle,
    @"windowX": @(windowBounds.origin.x),
    @"windowY": @(windowBounds.origin.y),
    @"windowWidth": @(windowBounds.size.width),
    @"windowHeight": @(windowBounds.size.height),
    @"accessibilityText": extracted[@"text"],
    @"accessibilityTrusted": @(trusted),
    @"textTruncated": extracted[@"truncated"],
  });
}

static void reportAccessibility(BOOL prompt) {
  NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @(prompt) };
  BOOL trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
  emitJSON(@{ @"ok": @YES, @"trusted": @(trusted) });
}

static BOOL leftPressed = NO;
static BOOL rightPressed = NO;
static BOOL shortcutFired = NO;
static int64_t leftKeyCode = 55;
static int64_t rightKeyCode = 54;
static CGEventFlags modifierFlag = kCGEventFlagMaskCommand;
static CFMachPortRef eventTap = NULL;

static CGEventRef shortcutCallback(CGEventTapProxy _, CGEventType type, CGEventRef event, void *__) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (eventTap) CGEventTapEnable(eventTap, true);
    return event;
  }
  if (type != kCGEventFlagsChanged) return event;

  int64_t keyCode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  if (keyCode == leftKeyCode) leftPressed = !leftPressed;
  if (keyCode == rightKeyCode) rightPressed = !rightPressed;
  if (!(CGEventGetFlags(event) & modifierFlag)) {
    leftPressed = NO;
    rightPressed = NO;
  }

  if (leftPressed && rightPressed && !shortcutFired) {
    shortcutFired = YES;
    emitJSON(@{ @"type": @"shortcut" });
  }
  if (!leftPressed || !rightPressed) shortcutFired = NO;
  return event;
}

static void listenForShortcut(NSString *shortcut) {
  if (!AXIsProcessTrusted()) {
    emitJSON(@{ @"type": @"error", @"code": @"accessibility" });
    exit(2);
  }

  if ([shortcut isEqualToString:@"option"]) {
    leftKeyCode = 58;
    rightKeyCode = 61;
    modifierFlag = kCGEventFlagMaskAlternate;
  } else if ([shortcut isEqualToString:@"control"]) {
    leftKeyCode = 59;
    rightKeyCode = 62;
    modifierFlag = kCGEventFlagMaskControl;
  }

  CGEventMask mask = CGEventMaskBit(kCGEventFlagsChanged);
  eventTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, shortcutCallback, NULL);
  if (!eventTap) {
    emitJSON(@{ @"type": @"error", @"code": @"accessibility" });
    exit(2);
  }

  CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0);
  CGEventTapEnable(eventTap, true);
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
  CFRelease(source);
  emitJSON(@{ @"type": @"ready" });
  CFRunLoopRun();
}

#ifndef APP_SNAPSHOT_HELPER_TESTING
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc > 1 && strcmp(argv[1], "inspect") == 0) {
      inspectFrontmostWindow();
      return 0;
    }
    if (argc > 1 && strcmp(argv[1], "listen") == 0) {
      listenForShortcut(argc > 2 ? [NSString stringWithUTF8String:argv[2]] : @"command");
      return 0;
    }
    if (argc > 1 && strcmp(argv[1], "accessibility") == 0) {
      reportAccessibility(argc > 2 && strcmp(argv[2], "prompt") == 0);
      return 0;
    }
    emitJSON(@{ @"ok": @NO, @"code": @"invalid_command", @"message": @"Expected inspect, listen, or accessibility" });
    return 64;
  }
}
#endif
