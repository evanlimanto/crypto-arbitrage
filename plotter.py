import sqlite3
import matplotlib.pyplot as plt
import numpy as np

DB_NAME = 'database.sqlite'
LIMIT = 0.15

conn = sqlite3.connect(DB_NAME)

c = conn.cursor()
c.execute("select distinct(code) from margins")
codes = [a[0] for a in c.fetchall()]

fig = plt.figure(figsize=(8, 8))
for (i, code) in enumerate(codes):
    print(i, code)
    c.execute("select * from margins where code = '{}' order by timestamp asc".format(code))
    items = c.fetchall()

    plt.subplot(5, 4, i + 1)
    plt.title(code)
    axes = plt.gca()
    axes.set_ylim([-0.1, LIMIT])
    plt.yticks(np.arange(-0.1, LIMIT + 0.01, 0.05))
    plt.plot([((item[2] // 1000) % 86400) for item in items], [item[3] for item in items])
fig.tight_layout()
plt.show()
