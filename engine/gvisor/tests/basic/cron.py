import time, threading, sys
t0w, t0m = time.time(), time.monotonic()
ticks = []
def hourly():
    for i in range(720):
        time.sleep(3600)
        ticks.append((time.time()-t0w, time.monotonic()-t0m))
def every_17_days():
    time.sleep(17*86400)
    print("chargeback thread woke at day %.4f" % ((time.monotonic()-t0m)/86400), flush=True)
a=threading.Thread(target=hourly); b=threading.Thread(target=every_17_days)
a.start(); b.start(); a.join(); b.join()
drift = max(abs(w-m) for w,m in ticks)
late = max(m-(i+1)*3600 for i,(w,m) in enumerate(ticks))
print("ticks=%d  last at day %.4f  max wall-vs-mono drift %.6fs  max lateness %.6fs" % (len(ticks), ticks[-1][1]/86400, drift, late))
