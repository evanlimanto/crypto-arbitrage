import sqlite3
import matplotlib.pyplot as plt

DB_NAME = 'database.sqlite'

conn = sqlite3.connect(DB_NAME)

c = conn.cursor()
c.execute("select distinct(code) from margins")
codes = [a[0] for a in c.fetchall() if 'NXT' not in a[0]]

fig = plt.figure(figsize=(8, 8))
for (i, code) in enumerate(codes):
    print(i, code)
    c.execute("select * from margins where code = '{}' order by timestamp asc".format(code))
    items = c.fetchall()

    plt.subplot(4, 5, i + 1)
    plt.title(code)
    axes = plt.gca()
    axes.invert_xaxis()
    last = items[-1][2]
    plt.plot([((last-item[2]) / 1000.0 / 60.0) for item in items], [item[3] for item in items])
fig.tight_layout()
plt.subplots_adjust(left=0.05, top=0.95, bottom=0.05, right=1.0, wspace=0.18, hspace=0.24)
plt.show()
