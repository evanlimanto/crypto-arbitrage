import sqlite3
import matplotlib.pyplot as plt

DB_NAME = 'database.sqlite'

conn = sqlite3.connect(DB_NAME)

c = conn.cursor()
c.execute("select distinct(code) from margins")
codes = [a[0] for a in c.fetchall() if 'NXT' not in a[0]]

plt.figure(figsize=(8, 8))
for (i, code) in enumerate(codes):
    print(i, code)
    c.execute("select max(timestamp) from margins")
    max_timestamp = c.fetchall()[0][0]

    c.execute("select * from margins where code = '{}' and {} - timestamp <= 200 * 60 * 1000 order by timestamp asc".format(code, max_timestamp))
    items = c.fetchall()

    last = items[-1][2]
    lastprice = items[-1][3] * 100

    plt.subplot(4, 5, i + 1)
    plt.title(code + (" %.2f" % lastprice), fontsize=8)

    axes = plt.gca()
    axes.invert_xaxis()
    axes.set_ylim(bottom=lastprice - 3, top=lastprice + 3)
    axes.yaxis.tick_right()
    axes.yaxis.set_label_position("right")
    plt.tick_params(axis='both', which='minor', labelsize=8)
    plt.tick_params(axis='both', which='major', labelsize=8)
    plt.plot([((last-item[2]) / 1000.0 / 60.0) for item in items], [item[3]*100 for item in items])
plt.tight_layout(pad=0.5, h_pad=1.0)
plt.subplots_adjust(left=0.01, top=0.95, bottom=0.05, right=0.96, wspace=0.18, hspace=0.24)
plt.show()
